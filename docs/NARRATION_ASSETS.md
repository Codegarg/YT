# Hindi narration assets (Phase 7)

This layer is an **inventory, not a second TTS system**. Hindi narration is still produced in Google
AI Studio by a human and dropped into `production/inputs/<projectId>/narration/`; `video narration`
adds the missing bookkeeping on top of that file drop, using the narration contract the rest of the
pipeline already reads:

- which scenes are narrator scenes vs. character dialogue (`narrationWorkflow.isNarrationScene`);
- the filename contract (`narration-####.<ext>`) and the scene audio ceiling
  (`narrationDuration.ts`, `SUPPORTED_AUDIO_EXTENSIONS`);
- real duration measured with `ffprobe` (`videoClip.probeMedia`) — never inferred from the text;
- the same provider/voice configuration the TTS boundary uses (`DEFAULT_NARRATION_VOICE`).

Nothing in this layer generates audio, calls a provider, opens a browser, spends credits, uploads or
publishes. The operator's audio files are opened **read-only**.

---

## 1. Where files live

| Path | Role |
| --- | --- |
| `production/inputs/<projectId>/narration/narration-0001.wav` … | Operator-supplied Hindi narration (never written by this layer) |
| `production/inputs/<projectId>/narration/pronunciation.json` | Optional read-only pronunciation/voice sidecar |
| `production/outputs/<projectId>/narration/narration-ledger.json` | The ledger (one record per required narrator scene) |
| `production/outputs/<projectId>/narration/narration-qa.json` | QA evidence bound to a ledger fingerprint + byte hashes |
| `production/outputs/<projectId>/narration/narration-approval.json` | Per-asset human approval, bound to exact bytes |

Writes are guarded: `assertInsideNarrationRoot` refuses any path that escapes
`outputs/<projectId>/narration/`. JSON is written atomically (`.tmp-<pid>-<stamp>` then rename) and a
pass that changes nothing leaves the previous file byte-identical.

## 2. Asset states

A bare "the file exists" check is not enough, so every asset gets one explicit state:

| State | Meaning | Blocks approval |
| --- | --- | --- |
| `ready` | Valid Hindi narration audio for the current script/voice/pronunciation | no |
| `missing` | No file for a required narrator scene | yes |
| `empty` | The file is 0 bytes | yes |
| `corrupt` | `ffprobe` cannot read it, or it cannot be hashed | yes |
| `format_invalid` | Readable but outside the delivery contract (codec, sample rate, channels, < 0.2 s, > scene ceiling, no audio stream) | yes |
| `stale` | Bytes are valid but were produced for an older script/voice/pronunciation intent | yes |

Accepted codecs: `pcm_s16le`, `pcm_s24le`, `pcm_s32le`, `pcm_f32le`, `pcm_u8`, `mp3`, `aac`, `flac`,
`opus`, `vorbis`. Accepted sample rates: 16000, 22050, 24000, 32000, 44100, 48000. Channels: 1–2.
Minimum duration 0.2 s; maximum is `MAX_SCENE_AUDIO_SECONDS` from `narrationDuration.ts`.

Narrator-vs-dialogue separation is inherited, not re-implemented: character-speaking scenes
(`speaker` not `NARRATOR`, or a scene with only `devanagari_dialogue`) are recorded as
`kind: "dialogue"`, `required: false`, and receive **no** narration asset. Their Flow audio is
preserved by the MIX stage exactly as before.

## 3. Ledger contents

`narration-ledger.json` (`NARRATION_LEDGER_VERSION = 1`, `read_only: true`):

- `voice` — `provider`, `model`, `voice`, `language`, `narrator_style` (from `DEFAULT_NARRATION_VOICE`,
  overridable by `pronunciation.json`);
- `pronunciation` — `schema_version`, `rules[]`, `config_hash`;
- `scene_texts[]` — per scene: `kind` (`narration`/`dialogue`), `required`, `raw_text`, `spoken_text`
  (after pronunciation rules), `text_hash`;
- `assets[]` — per narrator scene: `asset`, `relative_path`, `sha256`, `bytes`, measured
  `duration_seconds`, `container`, `codec`, `sample_rate`, `channels`, `text_hash`, `voice_hash`,
  `config_hash`, `input_key`, `state`, `reason`, `content_changed`, `provenance`;
- `missing_scenes`, `stale_scenes`, `invalid_scenes`;
- `total_duration_seconds` — the **sum of measured** durations only;
- `fingerprint` — SHA-256 over the ledger's input identity (script text, voice, pronunciation);
- `asset_set_hash` — SHA-256 over the ready assets' measured bytes;
- `warnings[]`.

`provenance` is `{ source: "provided_file" | "provider", provider, recorded_at, produced_for_input_key }`.
`produced_for_input_key` is **sticky for unchanged bytes**: it records the intent the bytes were
produced for, so reverting a pronunciation rule makes a line current again instead of leaving a
permanent `stale` flag, while editing the script marks it stale without re-recording anything.

## 4. Pronunciation and Devanagari handling

Optional sidecar at `inputs/<projectId>/narration/pronunciation.json` (or `--pronunciation <file>`):

```json
{
  "rules": [
    { "match": "कुएं", "say": "कू-एँ", "note": "folk pronunciation of \"well\"" }
  ],
  "voice": { "voice": "Kore", "language": "hi-IN" }
}
```

- Rules are applied **longest-match-first** (ties broken alphabetically), by literal replacement, then
  whitespace is normalised. A short rule can therefore never corrupt a longer Devanagari token.
- `spoken_text` is what a TTS request would actually say; `raw_text` is the story text.
- The sidecar is read-only. A malformed file produces a warning and the defaults are used — it is
  **never rewritten**.
- `config_hash` covers `{ voice, rules }` and is part of each asset's `input_key`, so adding/removing a
  rule marks the affected assets `stale` without touching a single audio byte.

## 5. Commands

```powershell
cd production

# 1. build/refresh the ledger (measures every narrator file with ffprobe, writes only outputs/<id>/narration/)
npm run video -- narration refresh --project ..\scripting\projects\your-project\pipeline.json

# 2. read-only status: states, measured durations, invalidation, QA/approval verdicts
npm run video -- narration status --project ..\scripting\projects\your-project\pipeline.json

# 3. QA against the current ledger (Phase 4 audio engine + narration contract)
npm run video -- narration qa --project ..\scripting\projects\your-project\pipeline.json

# 4. approve the exact bytes (human decision; requires --yes and QA bound to those bytes)
npm run video -- narration approve --project ..\scripting\projects\your-project\pipeline.json --yes --by "Ridham"

# machine-readable output for every subcommand
npm run video -- narration status --project-id <projectId> --json
```

Exit codes: `refresh` returns 1 when any narrator scene is `missing`/`stale`/`invalid`; `qa` returns 1
on `FAIL`; `approve` returns 1 unless the verdict is `APPROVED`. `status` is always read-only and
returns 0.

`--qa-warnings-block` makes WARNING-level QA evidence block approval.

## 6. QA checks

Per asset (`narration-qa.json → assets[].checks[]`):

| Check | Fails when |
| --- | --- |
| `narration.present` | The required file is absent |
| `narration.integrity` | The file is 0 bytes |
| `narration.hash` | The bytes differ from the ledger hash |
| `narration.state` | The ledger state is not `ready` (stale included) |
| `narration.probe` | `ffprobe` cannot read the file |
| `narration.duration` | Measured duration is missing / not positive |
| `narration.duration.bounds` | The measured duration disagrees with the ledger, or is outside 0.2 s…scene ceiling |
| `narration.format` | Codec/sample rate/channels outside the contract |
| `narration.media_qa` | The Phase 4 media engine itself fails on the file |
| `narration.silence.whole` | The whole line is silent (no speech) |
| `narration.silence.share` | Mostly silent (warning) |
| `narration.silence.trailing` | Long trailing silence (warning) |

Project-level (`set_checks[]`, also printed):

| Check | Fails when |
| --- | --- |
| `narration.set.complete` | Any required narrator scene has no `ready` asset |
| `narration.set.distinct` | Two scenes share identical bytes (a copy-paste mistake) |
| `narration.set.provenance` | An asset has no recorded provenance/hash |

The report carries `ledger_fingerprint`, `pronunciation_hash`, `artifact_hash`, `report_hash`,
`publishable: false` and `approval_required: true`. Re-running QA over identical bytes writes nothing.

## 7. Approval semantics

- Approval is **per asset**: `narration-approval.json → assets[]` records `scene_number`, `asset`,
  `sha256`, `duration_seconds`, `qa_report_hash`, `qa_asset_status`, `approved_at`.
- `approve` refuses (`REFUSED`, exit 1) when: `--yes` is missing; any asset is not `ready`; the set is
  incomplete; QA is missing or `FAIL` (or `WARNING` with `--qa-warnings-block`); or the QA evidence does
  not describe the current ledger (re-run `video narration qa`).
- A verdict is `APPROVED` only while the recorded hash equals the current bytes **and** the QA evidence
  for *those* bytes still exists with the same per-asset status. `STALE_APPROVAL` names the reason.
- Re-recording one line invalidates only that line's entry; untouched lines stay `APPROVED`.
- Approval is local evidence. It never writes `approval.json` for the long-form video, never marks
  anything publishable and never uploads.

## 8. Resume and selective invalidation

- `refresh` is content-addressed: with unchanged bytes/script/voice/pronunciation it writes nothing and
  the ledger file stays byte-identical.
- Each asset records the `sha256` it was built from. Dependents declare what they consumed:
  - `long-form:audio_mix` and `long-form:media_qa` claim the **previous** ledger pass's hashes (the bytes
    that run actually consumed), so a re-recorded line invalidates them;
  - every `outputs/<id>/shorts/<shortId>/short.json` claims the narration hashes it rendered from
    (`narration_hashes`, additive/optional), so a changed line invalidates exactly the Shorts that used it.
- `computeNarrationInvalidation` then reports `changed_scenes`, `stale_dependents`, `long_form_affected`
  and `shorts_affected`. One line changes → only its dependents are named.
- A narration change never invalidates a thumbnail or cover artifact (they do not consume audio).

Downstream, the MIX/BED/TITLE/QA stages keep using the **measured** durations from the same
`ffprobe` path; nothing here invents a duration from text length.

## 9. Guarantees

- `pipeline.json` is read-only; the `RELIABILITY_STAGES` 13-stage contract is untouched (narration stays
  a single `NARRATION` stage).
- Long-form media (`scene-*.mp4`, `final-*.mp4`), `approval.json`, SEO metadata and the real project's
  narration inputs are never modified.
- No paid/network call exists in the Phase 7 sources; the offline test suite asserts this and counts
  network attempts (0).

## 10. Known limitations

- Generation is still manual (Google AI Studio) and runs through the existing human handoff. This layer
  verifies and tracks; it does not synthesize.
- Silence/loudness findings come from the Phase 4 audio engine; extremely quiet ambience under speech is
  judged by that engine's thresholds, not by a speech recogniser.
- `stale` is intent-based: a change to the *story text* marks the line stale even if the operator
  considers the old take acceptable — re-record it (there is deliberately no "ignore staleness" flag).
- Per-asset approval assumes scene numbers are stable. Renumbering scenes in `pipeline.json` invalidates
  approvals by definition.
- Pronunciation rules are literal string replacements; they cannot express phoneme-level edits.
