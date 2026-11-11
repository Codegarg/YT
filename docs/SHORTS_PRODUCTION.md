# YouTube Shorts production (Phase 6)

Every eligible long-form story can now produce **two or three standalone vertical Shorts**
(1080×1920) that reuse the already-rendered scene clips. Shorts are a child scope: they never
touch the long-form story, its stage outputs, its metadata or its approval record.

This document covers the workflow, the planning format, clip reuse/reframing, vertical rendering,
Hindi narration and captions, metadata, QA, independent approval, recovery/resume and known
limitations.

---

## 1. Workflow

```powershell
cd production

# 1. derive 2–3 Shorts from the validated story (read-only apart from shorts/shorts-plan.json)
npm run video -- shorts plan --project ..\scripting\projects\your-project\pipeline.json --count 3

# 2. render them (reuses existing clips; never runs Flow)
npm run video -- shorts render --project ..\scripting\projects\your-project\pipeline.json
npm run video -- shorts render --project ..\scripting\projects\your-project\pipeline.json --short short-02

# 3. read-only status: state, QA, approval, re-render reason per Short
npm run video -- shorts status --project ..\scripting\projects\your-project\pipeline.json

# 4. Shorts QA (Phase 4 media engine + Shorts contract); writes only qa.json
npm run video -- shorts qa --project ..\scripting\projects\your-project\pipeline.json

# 5. approve ONE Short explicitly (QA-clean, hash-bound)
npm run video -- shorts approve --project ..\scripting\projects\your-project\pipeline.json --short short-01 --yes --by "your name"
```

`--project-id <id>` works anywhere `--project` does. `--json` prints the machine-readable report.
Exit codes: `0` ok, `1` failure/refused, `2` usage.

**Nothing in this workflow can generate, upload or publish.** There is no `--run-flow` switch on
`shorts`, no model provider is imported, and `publishable` is hard-coded `false` in every report.
Publishing stays the existing, separately-approved long-form handoff.

### Output layout

```
production/outputs/<projectId>/
  scene-0001.mp4 …            # long-form artifacts: READ-ONLY inputs, never written
  shorts/
    shorts-plan.json          # the plan for every Short
    short-01/
      short-01.mp4            # the rendered vertical Short
      short.json              # checkpoint (render key, hashes, duration, dimensions)
      captions.ass            # burned-in Devanagari track (the exact file used for the render)
      captions.srt            # portable review/upload track
      captions.json           # validated segments + caption hash
      metadata.json           # independent title/description/hashtags/tags/cover frame
      qa.json                 # Shorts QA evidence (hash-bound)
      approval.json           # written ONLY by `shorts approve --yes`
```

---

## 2. Planning format

`shorts plan` writes `shorts-plan.json`. Planning is **pure and deterministic**: the same story
with the same measured durations always produces the same Short IDs and the same `plan_hash`.

Selection is score-based, not positional:

1. every contiguous **3–6 scene** window is scored for hook strength, escalation and payoff;
2. windows whose first/last scene carries no spoken text are dropped;
3. a **self-containment penalty** applies when the arc's most frequent character never appears in
   the arc (or appears late) — a viewer who has not seen the long form must meet them inside it;
4. duration penalties discourage very short or very long arcs;
5. the highest-scoring **non-overlapping** arcs are picked greedily (ties: score, then earlier
   start, then longer arc) and finally ordered by story position;
6. IDs are `short-01`, `short-02`, `short-03` in story order.

Each Short records: `title`, `parent_title`, `scene_refs`, `hook`, `escalation[]`, `payoff`
(`reveal` | `cliffhanger`), `narration_segments`, `caption_segments`, `estimated_duration_seconds`,
`composition`, `sound_design`, `clips` (reuse evidence), `coherence` (independent-coherence checks)
and `metadata`.

An unchanged story leaves the existing plan file untouched (`(unchanged)` is printed). The long-form
`pipeline.json` is only read.

---

## 3. Clip reuse and reframing

Each selected scene resolves to a clip in this order:

1. `outputs/<projectId>/scene-####.mp4` (the already-rendered, approved output)
2. `inputs/<projectId>/flow-clips/scene-####.mp4` (the Flow download)

Each clip is verified with the existing `validateVideoClip` layer: container, streams, duration,
SHA-256 and a minimum source size of 640×360. A missing, unreadable, too-small or hash-mismatched
clip becomes `REPLACE_OR_REVIEW` and the Short is refused — a stale clip is never shipped silently.

Reframing is a recorded decision (`ReframePlan`), not an invisible crop:

| Mode        | When                              | What happens                                                     | Framing |
|-------------|-----------------------------------|------------------------------------------------------------------|---------|
| `cover`     | portrait / exactly 9:16           | fill 1080×1920, crop height only (full width kept)               | SAFE    |
| `crop`      | landscape, square, 3:4 portrait   | centred 9:16 window, keeping ≥30% of the width                   | SAFE    |
| `crop`      | very wide (18–30% retained)       | same crop, flagged for a human to confirm                        | REVIEW  |
| `blur_fill` | extremely wide (<18% retained)    | full frame letterboxed over a blurred, cropped copy of itself    | REVIEW  |

Subject anchoring accepts `anchorX` (0–1) clamped to 10–90% so a crop can never be pushed to an
edge. `validateReframe` proves the rectangle is inside the source, exactly 9:16, and that
`retained_fraction` matches the rectangle. REVIEW framing is only ever a QA **WARNING**.

No new paid Flow generation is possible here: short clips are reused, and the Phase 2 gates remain
the only path to generation.

---

## 4. Vertical rendering

`shorts render` builds one deterministic ffmpeg graph per Short:

- every scene is normalised to **1080×1920 @ 24 fps, SAR 1:1, yuv420p**;
- a scene timeline window is `max(clip, narration + 0.25s)` — full narration is always preserved,
  and the picture is extended with a cloned last frame (`tpad`) when narration runs long;
- audio is padded/trimmed to the same window, so picture and sound cannot drift;
- scenes are joined with short per-scene audio+video fades (0.15 s) via `concat` — no overlapping
  speech at the joins;
- the joined audio bus is normalised to **−14 LUFS** (`loudnorm`, TP −1.5) — the same narrator
  target as long-form;
- Devanagari captions are burned in from `captions.ass`;
- the channel logo (`inputs/<projectId>/branding/channel-logo.png`, optional) is overlaid
  **top-right** at the long-form proportional size (10.56% of frame height). On Shorts the
  bottom-right corner is occupied by the platform action rail, so the brand moves, not the size.

Encoding is `libx264 -preset medium -crf 20` + AAC 192 kb/s, `-map_metadata -1`, `+faststart`.
The render writes a temp file inside the Short's own directory and atomically renames it — it can
never write outside `outputs/<projectId>/shorts/<shortId>/`, and never overwrites a long-form file.

The render key is
`hash(plan_hash + renderer version + logo hash + caption hash + metadata hash + per-scene clip hash/reframe/window/audio + narration hash)`.
It is content-bound: replacing a clip or re-recording a line re-renders that Short even when the
duration is unchanged. An unchanged key with a matching artifact hash means the Short is reused
without re-rendering.

---

## 5. Hindi narration and captions

Existing narration assets are reused. Where a scene is a narrator scene in the long form
(`isNarrationScene`), the matching `inputs/<projectId>/narration/narration-####.wav` is used;
character-speaking scenes keep the Flow clip's own dialogue audio. Nothing is synthesised here — no
TTS provider, no model call.

Captions (`shortsCaptions.ts`) are pure and deterministic:

- Devanagari text is split on `। ? !` first, then `, ; :`, then words — **a word is never split**;
- at most **2 lines** per caption, sized by `maxCharsPerLine` for the portrait width;
- timing is distributed inside each scene's measured narration window proportionally to character
  weight, so slow/paused lines get more screen time and pauses are preserved;
- the safe band is 80 px left, 160 px right (action rail) and 380 px from the bottom (platform UI);
- reading speed above 17 chars/s is a WARNING; anything outside the safe band, an overlap or an
  over-long line is a BLOCKER.

`captions.ass` is authored at `PlayResX/Y 1080/1920` with font `Noto Sans Devanagari` (libass falls
back to an installed Devanagari face such as Nirmala UI on Windows). No machine-specific font
directory is baked into the file.

---

## 6. Metadata

`metadata.json` is independent of the long-form `youtube-metadata.json`, which is never read or
written:

- its own title (derived from the Short's hook, ≤70 chars) — a Short may not reuse the long-form title;
- its own description built from the hook and payoff plus an explicit parent-story reference;
- hashtags (`#shorts`, `#horrorstories`, `#hindikahani`, plus keyword-derived tags, max 6);
- tags (max 14), `language: "hi"`, `category: "Entertainment"`;
- `parent_story: { project_id, title }`;
- a deterministic cover frame (≈62% into the Short, the payoff window);
- `metadata_hash` over every field above.

The metadata hash is part of the render key, so editing metadata re-renders only that Short.

---

## 7. Shorts QA

`shorts qa` reuses the Phase 4 engine (`runMediaQa`) and adds the Shorts contract:

| Check | Failure mode |
|-------|--------------|
| `short.exists` | missing/empty artifact — BLOCKER |
| `short.dimensions_1080x1920` | anything but exactly 1080×1920 — BLOCKER |
| `short.orientation` / `short.aspect_9_16` | landscape or non-9:16 — BLOCKER |
| `short.duration` / `_convention` | outside 8–75 s — BLOCKER; above 60 s — WARNING |
| media findings | streams, fps 24, container, A/V duration, black/freeze, loudness — BLOCKER/WARNING |
| `short.audio_sync` | picture/sound drift > 0.5 s — BLOCKER |
| `caption.*` | order, timing, line length, safe area — BLOCKER; reading speed — WARNING |
| `short.scene_count` / `_order` | a dropped or reordered scene — BLOCKER |
| `short.clip_reuse` | an unusable clip — BLOCKER |
| `short.duplicate_clips` | the same source clip twice — WARNING |
| `short.reframe_metadata` | inconsistent crop/cover metadata — BLOCKER |
| `short.framing_review` | REVIEW framing — WARNING (human confirmation) |
| `short.narration_coverage` | planned speech with no audio at all — BLOCKER |
| `short.metadata` | invalid or copied long-form title — BLOCKER |
| `short.artifact_hash` | hash differs from the checkpoint — BLOCKER |

A technically invalid Short can never pass. Visual/crop uncertainty is only ever a WARNING.
`publishable` is always `false` and `approval_required` is always `true`. `reportHash` is the
SHA-256 of the report and `artifactHash` is the SHA-256 of the exact bytes evaluated.

---

## 8. Independent approval

Approval is per Short and hash-bound:

- `shorts approve --short <id> --yes` is refused when the Short is unrendered, when QA is missing or
  has a blocker, when the QA report was produced for different bytes, when the artifact hash does
  not match the checkpoint, or when `--sha256` does not match;
- `--qa-warnings-block` treats warnings as blocking too;
- the record (`short.json` sibling `approval.json`) has `artifact_kind: "short"`, the approved output
  path/hash, the approved render key and the QA evidence hash;
- changing the artifact bytes, or any render input, makes the approval `STALE_APPROVAL`;
- the long-form `approval.json` is a different file and is never read as Shorts approval nor written.

Approving a Short does not make the pipeline publishable. Publishing remains the existing,
separately-approved long-form handoff.

---

## 9. Recovery and resume

- Each Short owns `shorts/<shortId>/short.json` (render key, plan hash, clip hashes, caption hash,
  metadata hash, output hash, duration, dimensions, renderer version).
- `render` reuses a Short when the recomputed key matches the checkpoint **and** the artifact bytes
  still hash to the recorded value.
- A changed narration file, clip, caption or metadata re-renders only the Short(s) that use it.
- A missing artifact, a changed artifact hash or a changed input is reported per Short by `status`
  as `rerender_reason` (`no checkpoint`, `inputs changed`, `artifact missing`, `artifact hash changed`).
- A re-render deletes that Short's stale `qa.json` and `approval.json` — and nothing else.
- Nothing is ever auto-deleted from the long-form tree; a failed render leaves long-form artifacts
  exactly as they were.

States reported by `shorts status`: `planned`, `rendered`, `qa_failed`, `awaiting_approval`,
`approved`, `stale`, `failed`.

---

## 10. Known limitations

- **No subject detection.** Reframing is centre-based (with an optional anchor); it cannot know
  where a face or a subtitle sits inside the source frame. That is exactly why reduced crops and
  blurred backdrops are surfaced as REVIEW warnings for a human.
- **Plan captions are estimates.** The plan stores approximate caption timings from estimated
  durations; the authoritative track is built from measured narration at render time and stored in
  `captions.json` with its own hash.
- **No music bed per Short.** The −14 LUFS narration bus is normalised, but the long-form horror
  music bed is not mixed into Shorts (it would need a Shorts-specific stem decision).
- **Story arcs never cross the end of the story.** Arcs are contiguous scene windows; a Short cannot
  interleave two distant parts of the story.
- **No automatic repair of an unusable clip.** `REPLACE_OR_REVIEW` requires a re-render of that scene
  through the existing long-form path (which keeps the Phase 2 gates) or a manual decision.
- **Caption font availability.** Devanagari glyphs need an installed Devanagari face; libass falls
  back per glyph, but a machine with no Devanagari font would render boxes.
- **No upload/publish.** By design. This layer cannot publish anything.
