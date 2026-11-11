# Media QA (Phase 4)

Offline, read-only media quality assurance for finished scenes, narration audio and the final
TITLE render. It answers one question before approval and publishing: **is this exact media
complete, technically valid and suitable for the programme?**

Nothing in this layer renders, transcodes, downloads, uploads or publishes. Every ffmpeg
invocation writes to the `null` muxer (`-f null -`); ffprobe is used for metadata only. The QA
code never writes media, sidecars, state, checkpoints, generation ledgers or approval records.

- Engine: `production/src/mediaQa.ts` (single-file measurement + severity policy)
- Project composition: `production/src/projectMediaQa.ts` (scene / narration / final roll-up)
- Probe helpers: `production/src/videoClip.ts` (`inspectClipProbe`, `probeMedia`)
- Approval boundary: `production/src/approval.ts` (`mediaQa`, `blockOnMediaQaWarnings`, `media_qa` evidence)
- CLI: `production/src/video.ts` (`video qa`, `video approve`)

There is exactly **one** QA engine. The project layer only chooses *which* assets to probe and
*what* is expected of each; it never re-implements a measurement.

---

## 1. Workflow

```
scene clips ─┐
narration   ─┼─► runMediaQa (ffprobe + ffmpeg -f null) ─► structured checks ─► project roll-up
final TITLE ─┘                                                   │
                                                                 ├─► human report + JSON report
                                                                 └─► approval gate (hash-bound)
```

1. **Scene clips** (`outputs/<project>/scene-####.mp4`): container, streams, dimensions, aspect,
   frame rate, expected duration, black/freeze warnings, plus cross-checks against the render
   sidecar (`scene-####.json`).
2. **Narration** (`inputs/<project>/narration/narration-####.*`): audio stream, loudness/clipping,
   unexpected silence. Only scenes whose manifest carries `narration_text` are *required* to have
   narration; character-dialogue scenes without a narration file are not treated as missing.
3. **Final render** (`outputs/<project>/final-title.mp4` or the exact candidate being approved):
   container, required video **and audio** streams, dimensions/aspect, duration, black/freeze and
   audio checks, plus a duration cross-check against the edit-stage render.
4. **Roll-up**: per-scene and per-group summaries, blocker/warning counts, artifact hashes, and a
   deterministic report hash.

QA is re-runnable at any time and does not change the media it measures.

---

## 2. Check statuses

Every check is one of four explicit statuses. Nothing is silently clean.

| Status | Meaning | Blocks approval? |
| --- | --- | --- |
| `PASS` | The measurement ran and is within contract. | No |
| `WARNING` | A real but uncertain finding a human should review (black frames that may be fades, loudness slightly off target, reused scene media…). | No, unless `--qa-warnings-block` was requested |
| `FAIL` | A technical failure: missing/corrupt media, missing required streams, wrong dimensions/frame rate, duration mismatch, clipping, A/V duration mismatch, silent narration. | **Yes — always** |
| `SKIPPED` | The check was deliberately not applicable or not configured (audio optional, no size floor, black analysis disabled, branding not detectable offline). | No |

Each check carries: `id`, `asset`, `status`, `severity` (`BLOCKER`/`WARNING`/`INFO`/`SKIPPED`),
`expected`, `actual`, `explanation` and (for actionable results) `remedy`.

Group/report status: `FAIL` if any check failed, else `WARNING` if any warned, else `PASS`.

### Required vs optional

- **Required always:** readable container, required video stream, required audio stream on the
  final render, 16:9 picture, minimum height, expected duration/–frame rate *when configured*,
  clipping/true-peak, A/V duration agreement, scene provenance vs the render sidecar.
- **Optional (explicitly configured):** file-size floor, expected narration duration, scene reuse
  warnings, black/freeze passes (`--skip-black` / `--skip-freeze`), silence pass (`--skip-audio`,
  `skipSilence`, `allowAudioSilence`), a specific final duration.
- **Not performed offline (disclosed in `skipped`):** branding/logo detection, burned-in subtitle
  verification, scene-transition continuity, music-stem isolation.

A missing asset is never "skipped": a missing scene is `FAIL` (`file.exists`), and a missing
final render yields `FAIL` with `artifactHash: null` so it can never become approval evidence.

---

## 3. CLI

### Single file

```powershell
cd production
npm run video -- qa --input outputs\your-project\final-title.mp4
npm run video -- qa --input outputs\your-project\final-title.mp4 --json
```

Options: `--target-lufs`, `--loudness-tolerance`, `--min-height`, `--target-height`,
`--expect-duration`, `--duration-tolerance`, `--black-min`, `--freeze-min`, `--skip-black`,
`--skip-freeze`, `--skip-audio`, `--json`.

Exit codes: `0` = PASS/WARNING, `1` = FAIL, `2` = usage.

### Whole project

```powershell
npm run video -- qa --project ..\scripting\projects\your-project\pipeline.json
npm run video -- qa --project-id your-project --json
npm run video -- qa --project-id your-project --final outputs\your-project\candidate.mp4
```

Project options: `--final <artifact>` (evaluate a specific render, e.g. a candidate),
`--skip-scenes`, `--skip-narration`, `--skip-final`, `--min-height`, `--target-height`,
`--expect-duration`, `--duration-tolerance`, `--skip-black`, `--skip-freeze`, `--json`.

Exit codes: `0` = PASS/WARNING (warnings printed), `1` = FAIL, `2` = usage.

### Approval

```powershell
npm run video -- approve --project ..\scripting\projects\your-project\pipeline.json --yes
npm run video -- approve --project ..\scripting\projects\your-project\pipeline.json --yes --qa-warnings-block
```

`video approve` runs the project QA read-only against the **exact artifact being approved**
(`final-title.mp4`, or the `--candidate` file). Blockers refuse approval; warnings are stored in
the record and shown; `--qa-warnings-block` makes warnings blocking too. QA cannot approve,
publish, or bypass any existing approval precondition.

---

## 4. Configuration and thresholds

Defaults live in `QA_DEFAULTS` (`mediaQa.ts`) and `ProjectMediaQaOptions` defaults.

| Setting | Default | Notes |
| --- | --- | --- |
| `targetLufs` | `-14` | Spoken-content target (matches the narrator chain). `0 LUFS` is never a target. |
| `loudnessToleranceLu` | `3` | Outside this is a `WARNING` (`audio.loudness`). |
| `minHeight` | `720` | Hard floor for the channel's 1280×720 master. |
| `targetHeight` | `1080` (single file) / `720` (project) | Below-target is a warning only. |
| `durationToleranceSeconds` | `2` | Used when an expected duration is configured. |
| `fpsTolerance` | `0.05` | Absorbs 23.976/24 rounding. |
| `avSyncToleranceSeconds` | `0.5` | Maximum video/audio stream duration difference. |
| `silenceNoiseDb` | `-50` | silencedetect floor; segments shorter than 1 s are ignored. |
| `blackMinSeconds` | `0.5` | blackdetect minimum segment. |
| `freezeMinSeconds` | `3` | freezedetect minimum segment. |
| `minBytes` | unset | Optional "unexpectedly small output" floor; `SKIPPED` when unset. |

Project defaults intentionally match Flow sources: scene clips and the final master are 1280×720,
so the project layer uses `minHeight = targetHeight = 720` instead of warning about 1080p. Use the
single-file command with `--target-height 1080` if you want the 1080p preference applied.

---

## 5. Artifact hash association

- `runMediaQa` reports `sha256` of the exact bytes it measured.
- `runProjectMediaQa` reports `artifactHash` = SHA-256 of the final artifact it measured, and
  `reportHash` = SHA-256 of the canonicalised report (`stableStringify`, excluding `reportHash`).
- `qaAuthorizesArtifact(report, hash)` is true only when the report does not FAIL and
  `artifactHash` equals the hash being approved.
- On approval, the record gains optional `media_qa` evidence:

```json
{
  "media_qa": {
    "status": "WARNING",
    "artifact_hash": "<sha256 of the approved bytes>",
    "report_hash": "<sha256 of the QA report>",
    "generated_at": "2026-01-01T00:00:00.000Z",
    "blockers": 0,
    "warnings": 3,
    "checks": [{ "id": "visual.black", "asset": "scene-0007", "status": "WARNING", "severity": "WARNING", "explanation": "…" }]
  }
}
```

If the artifact changes after QA, the old evidence no longer matches: `evaluateApproval` returns
`STALE_APPROVAL`, and `validateApprovalRecord` refuses to persist evidence whose `artifact_hash`
does not match `approved_final_output_hash` (or whose status is `FAIL`). Re-running QA on the
changed bytes produces a new `artifactHash`, which never authorizes the previous approval.

Approvals written before Phase 4 have no `media_qa` field and remain valid; the gate only adds
evidence, it never rewrites existing artifacts or records.

---

## 6. Approval integration

`approveProject` accepts two optional seams:

- `mediaQa(args) => Promise<ProjectMediaQaReport>` — wired by `video approve`; runs read-only.
- `blockOnMediaQaWarnings: boolean` — explicit reviewer choice (`--qa-warnings-block`).

Outcomes when the QA boundary is present:

| Condition | Result |
| --- | --- |
| QA throws | `QA_UNAVAILABLE` — approval refused |
| QA does not evaluate a final artifact (`artifactHash: null`) | `QA_UNAVAILABLE` |
| QA measured a different hash than the artifact being approved | `QA_STALE` |
| Report status `FAIL` | `QA_BLOCKED` |
| Status `WARNING` and warnings blocking | `QA_BLOCKED` |
| Status `PASS`/`WARNING` (allowed) | approval proceeds and stores `media_qa` evidence |

Idempotency compares the artifact hash, status and blocker/warning counts, so approving the same
unchanged artifact again does not rewrite the record. All Phase 2 generation safety and Phase 3
validation gates are untouched: QA runs after those preconditions, never instead of them.

---

## 7. Known limitations and false-positive considerations

- **Black frames are warnings.** Horror deliberately uses black frames, fades and night exteriors.
  `visual.black` never fails; reviewers confirm intent. `--skip-black` removes the pass entirely.
- **Freeze frames are warnings.** Deliberate stills and held frames are common. `--skip-freeze`
  disables the pass; a freeze that runs to end-of-clip is closed at the probed duration.
- **Scene silence is expected.** Scene clips carry ambience/dialogue; the project layer skips the
  silence pass for scenes and treats scene audio as optional. Only the final render requires audio,
  and silent *narration files* fail (they are a broken asset).
- **Loudness is measured on the final mix**, not on separated stems; a music-only quiet bed can
  report `audio.silence` or low loudness warnings. The bed target (`-20.9 LUFS`) is a mix-time
  setting, not a QA target for the whole programme.
- **Missing narration is a warning, not a blocker**, because character-speaking scenes have no
  narrator line and some projects source voice from Flow. Present-but-silent or corrupt narration
  is a failure.
- **Scene reuse** (identical media in two scenes) is a warning; intentional reuse is allowed.
- **Scene transitions, burned-in text/watermarks and subtitle timing** are not detectable offline;
  they are listed in `skipped` and still require human review.
- **Frame-rate expectations are per asset.** Flow scene clips and the 30 fps final render differ by
  design; never set a single `expectFps` across both.
- **QA is not a creative review.** It cannot judge story, acting, lip-sync quality or taste.

---

## 8. Tests

- `production/tests/media_qa_test.mts` — parser, severity policy and end-to-end probe (existing).
- `production/tests/media_qa_expansion_test.mts` — Phase 4: valid/missing/corrupt media, stream
  presence, resolution, frame rate, duration, black/dark, freeze/still, clipping/silence, A/V
  mismatch, missing scene, ordering, reuse, stable JSON, approval blocking, warning visibility,
  hash invalidation and proof that QA mutates nothing.

All media is generated into a temporary directory with the local ffmpeg. The real production
project and its approved artifacts are never read or written by these tests.
