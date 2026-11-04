# raat-ka-khauf-3am-kuan — Human Asset Supply Handoff

**Status: NOT SUPPLIED. The project is currently `WAITING_FOR_INPUTS`.**

This document describes exactly what a human must supply before production execution can be
attempted. Nothing here is created automatically.

- Validator contract: `8dm-1`
- Pipeline fingerprint: `0c654402dad814f11c3e498cfd541667aabd65e24d7a17db01219bbd7491dcfb`
- Checklist rows: **77** (47 REQUIRED, 30 optional)
- Source of truth: `production:check --draft-manifest` (generated from `pipeline.json`)

> The checklist table in this document is generated from the pipeline. If the pipeline changes,
> this document must be regenerated rather than hand-edited.

---

## 1. Canonical input directory

```
production/inputs/raat-ka-khauf-3am-kuan/
    backgrounds/
    characters/
    narration/
    flow-clips/
    music/
    branding/
```

- This directory is **human-supplied**.
- Production diagnostics **must not create it** (they report `MISSING`).
- **Filenames are contractually significant** — they map tags/scenes to assets.
- Files **must satisfy the validators** before production execution.
- **Invalid files must be replaced by a human** — the tooling never repairs or resizes them.

---

## 2. Backgrounds

| | |
|---|---|
| Destination | `backgrounds/<TAG-STEM>.png` |
| Accepted | PNG, WebP |
| Minimum | 1280×720 |
| Aspect | 16:9-compatible (tolerance 0.09) |
| Also required | valid PNG signature + IHDR dimensions |

Background assets must be **clean visual assets** and must **not** contain UI controls, Flow
labels, browser chrome, accessibility icons, model-sheet overlays, or unrelated watermarks.

Required identities (derived from the pipeline): `#BGD-01-VILLAGE-STREET-WIDE`, `#BGD-02-WELL-AREA-WIDE`, `#BGD-03-WELL-AREA-CLOSE`, `#BGD-04-VILLAGE-ELDERS-HOUSE-INTERIOR`, `#BGD-05-VILLAGE-STREET-CLOSE`.

---

## 3. Characters

| | |
|---|---|
| Destination | `characters/<TAG-STEM>.png` (or `.webp`) |
| Accepted | .png, .webp |
| Minimum | 1024×1024 |
| Aspect | square-compatible |
| **Alpha** | **required** — an opaque image is NOT a cutout |

> **A Flow character tile screenshot is NOT a valid character asset.** Model sheets and any
> image without a transparent alpha cutout will be **rejected** by the validator.

Required identities: `@CHAR-01-ARJUN`, `@CHAR-02-MOHAN`, `@CHAR-03-GEETA`, `@CHAR-04-BUZURG`.

---

## 4. Narration

| | |
|---|---|
| Destination | `narration/narration-####.<ext>` |
| Accepted | .wav, .mp3, .m4a, .aac, .ogg |
| Mapping | exactly **one** unambiguous file per scene |
| Duration | measured by **ffprobe** only |

Only the scenes that actually require narration audio are listed below. Two files for one scene
(e.g. `.wav` and `.mp3`) are reported as **ambiguous** and must be reduced to one.

No assumed durations, no nominal Flow duration, no fabricated audio.

Narration scenes: scene 1, scene 5, scene 6, scene 7, scene 9, scene 10, scene 11, scene 17, scene 22, scene 31, scene 33, scene 34, scene 35.

---

## 5. Flow scene clips

| | |
|---|---|
| Destination | `flow-clips/scene-####.mp4` |
| Accepted | .mp4, .m4v |
| Required streams | **video AND audio** (`edit.ts` requires audio) |
| Minimum | 640×360 |
| Duration | measured by **ffprobe** only |

**REQUIRED vs OPTIONAL**

- **REQUIRED** — dialogue scenes (speaker is a character): no local speech synthesis exists, so a
  supplied clip is mandatory. There are **22** such scenes.
- **optional** — narrator-driven scenes can be produced by local synthesis; a supplied clip is
  optional. There are **13**.

> **The Flow generation setting "8 seconds" is NOT accepted as the clip's actual duration.**
> Only the supplied media's ffprobe-measured duration is authoritative.

---

## 6. Music (BGM)

| | |
|---|---|
| Audio | `music/background-music.mp3` |
| Provenance | `music/background-music.license.json` |

```json
{ "license": "CC0", "attribution": null, "source": "human-supplied" }
```

| ACCEPT | REJECT |
|---|---|
| CC0 | CC-BY-NC |
| Public Domain (as represented by the validator) | CC-BY-ND |
| CC-BY **with** attribution metadata | unknown licence |
| | missing provenance |

Nothing is downloaded; the human supplies both the audio and its licence metadata.

---

## 7. Branding

| | |
|---|---|
| Intro | `branding/channel-intro.mp4` — video+audio, duration via ffprobe |
| Logo | `branding/channel-logo.png` — valid PNG signature |

No placeholders are created, and unrelated branding is never reused automatically.

---

## 8. Manifest workflow

**A. Draft** (read-only, stdout only):
```bash
npm run production:check -- --project scripting/projects/raat-ka-khauf-3am-kuan/pipeline.json --draft-manifest --json
```

**B.** Human supplies files into the canonical input directory.

**C.** Human fills the manifest using actual relative paths.

**D. Validate** (read-only):
```bash
npm run production:check -- --project scripting/projects/raat-ka-khauf-3am-kuan/pipeline.json --validate-manifest <manifest.json> --json
```

**E.** Fix every reported issue.

**F.** Repeat until `status = VALID`.

Only after `VALID` should production execution be *considered* (see the execution gate).

---

## 9. Manifest status meanings

| Status | Meaning |
|---|---|
| `VALID` | schema ok, pipeline matches, all required assets exist and validate, supplied hashes match, no duplicate/path violations |
| `INCOMPLETE` | schema ok, pipeline matches, one or more **required** assets missing |
| `INVALID` | schema / path / duplicate / media / licence / hash errors |
| `PIPELINE_MISMATCH` | manifest was generated for a different pipeline revision |

Priority:

```
PIPELINE_MISMATCH > INVALID > INCOMPLETE > VALID
```

**The issue list remains complete even when a higher-priority status is returned** — one problem
never hides another.

---

## 10. Supply table

| Category | ID | Expected file | Required? | Validation | Supplied? |
|---|---|---|---|---|---|
| backgrounds | `#BGD-01-VILLAGE-STREET-WIDE` | `backgrounds/BGD-01-VILLAGE-STREET-WIDE.png` | **REQUIRED** | PNG/WebP · >=1280x720 · 16:9 (tolerance 0.09) | ☐ |
| backgrounds | `#BGD-02-WELL-AREA-WIDE` | `backgrounds/BGD-02-WELL-AREA-WIDE.png` | **REQUIRED** | PNG/WebP · >=1280x720 · 16:9 (tolerance 0.09) | ☐ |
| backgrounds | `#BGD-03-WELL-AREA-CLOSE` | `backgrounds/BGD-03-WELL-AREA-CLOSE.png` | **REQUIRED** | PNG/WebP · >=1280x720 · 16:9 (tolerance 0.09) | ☐ |
| backgrounds | `#BGD-04-VILLAGE-ELDERS-HOUSE-INTERIOR` | `backgrounds/BGD-04-VILLAGE-ELDERS-HOUSE-INTERIOR.png` | **REQUIRED** | PNG/WebP · >=1280x720 · 16:9 (tolerance 0.09) | ☐ |
| backgrounds | `#BGD-05-VILLAGE-STREET-CLOSE` | `backgrounds/BGD-05-VILLAGE-STREET-CLOSE.png` | **REQUIRED** | PNG/WebP · >=1280x720 · 16:9 (tolerance 0.09) | ☐ |
| characters | `@CHAR-01-ARJUN` | `characters/CHAR-01-ARJUN.png` | **REQUIRED** | .png/.webp · >=1024x1024 · square-compatible · alpha required | ☐ |
| characters | `@CHAR-02-MOHAN` | `characters/CHAR-02-MOHAN.png` | **REQUIRED** | .png/.webp · >=1024x1024 · square-compatible · alpha required | ☐ |
| characters | `@CHAR-03-GEETA` | `characters/CHAR-03-GEETA.png` | **REQUIRED** | .png/.webp · >=1024x1024 · square-compatible · alpha required | ☐ |
| characters | `@CHAR-04-BUZURG` | `characters/CHAR-04-BUZURG.png` | **REQUIRED** | .png/.webp · >=1024x1024 · square-compatible · alpha required | ☐ |
| narration | `narration-0001` (Village Night) | `narration/narration-0001.wav` | **REQUIRED** | .wav/.mp3/.m4a/.aac/.ogg · one file per scene · duration via ffprobe | ☐ |
| narration | `narration-0005` (Mohan Retreats) | `narration/narration-0005.wav` | **REQUIRED** | .wav/.mp3/.m4a/.aac/.ogg · one file per scene · duration via ffprobe | ☐ |
| narration | `narration-0006` (Clock Ticking) | `narration/narration-0006.wav` | **REQUIRED** | .wav/.mp3/.m4a/.aac/.ogg · one file per scene · duration via ffprobe | ☐ |
| narration | `narration-0007` (Arjun at Well) | `narration/narration-0007.wav` | **REQUIRED** | .wav/.mp3/.m4a/.aac/.ogg · one file per scene · duration via ffprobe | ☐ |
| narration | `narration-0009` (Question Raised) | `narration/narration-0009.wav` | **REQUIRED** | .wav/.mp3/.m4a/.aac/.ogg · one file per scene · duration via ffprobe | ☐ |
| narration | `narration-0010` (Arjun Leans) | `narration/narration-0010.wav` | **REQUIRED** | .wav/.mp3/.m4a/.aac/.ogg · one file per scene · duration via ffprobe | ☐ |
| narration | `narration-0011` (Voice Pleads) | `narration/narration-0011.wav` | **REQUIRED** | .wav/.mp3/.m4a/.aac/.ogg · one file per scene · duration via ffprobe | ☐ |
| narration | `narration-0013` (पहली रात) | `narration/narration-0013.wav` | **REQUIRED** | .wav/.mp3/.m4a/.aac/.ogg · one file per scene · duration via ffprobe | ☐ |
| narration | `narration-0014` (दूसरी रात) | `narration/narration-0014.wav` | **REQUIRED** | .wav/.mp3/.m4a/.aac/.ogg · one file per scene · duration via ffprobe | ☐ |
| narration | `narration-0015` (तीसरी रात) | `narration/narration-0015.wav` | **REQUIRED** | .wav/.mp3/.m4a/.aac/.ogg · one file per scene · duration via ffprobe | ☐ |
| narration | `narration-0016` (मोहन की चिंता) | `narration/narration-0016.wav` | **REQUIRED** | .wav/.mp3/.m4a/.aac/.ogg · one file per scene · duration via ffprobe | ☐ |
| narration | `narration-0017` (फोन नेटवर्क नहीं) | `narration/narration-0017.wav` | **REQUIRED** | .wav/.mp3/.m4a/.aac/.ogg · one file per scene · duration via ffprobe | ☐ |
| narration | `narration-0018` (बुजुर्ग से मुलाकात) | `narration/narration-0018.wav` | **REQUIRED** | .wav/.mp3/.m4a/.aac/.ogg · one file per scene · duration via ffprobe | ☐ |
| narration | `narration-0019` (अर्जुन का सवाल) | `narration/narration-0019.wav` | **REQUIRED** | .wav/.mp3/.m4a/.aac/.ogg · one file per scene · duration via ffprobe | ☐ |
| narration | `narration-0020` (बुजुर्ग की पुष्टि) | `narration/narration-0020.wav` | **REQUIRED** | .wav/.mp3/.m4a/.aac/.ogg · one file per scene · duration via ffprobe | ☐ |
| narration | `narration-0021` (दीपक और तुलसी) | `narration/narration-0021.wav` | **REQUIRED** | .wav/.mp3/.m4a/.aac/.ogg · one file per scene · duration via ffprobe | ☐ |
| narration | `narration-0022` (प्रार्थना) | `narration/narration-0022.wav` | **REQUIRED** | .wav/.mp3/.m4a/.aac/.ogg · one file per scene · duration via ffprobe | ☐ |
| narration | `narration-0023` (आवाज़ की शांति) | `narration/narration-0023.wav` | **REQUIRED** | .wav/.mp3/.m4a/.aac/.ogg · one file per scene · duration via ffprobe | ☐ |
| narration | `narration-0024` (मोहन की प्रशंसा) | `narration/narration-0024.wav` | **REQUIRED** | .wav/.mp3/.m4a/.aac/.ogg · one file per scene · duration via ffprobe | ☐ |
| narration | `narration-0025` (Village Elder) | `narration/narration-0025.wav` | **REQUIRED** | .wav/.mp3/.m4a/.aac/.ogg · one file per scene · duration via ffprobe | ☐ |
| narration | `narration-0026` (Spirit's Identity) | `narration/narration-0026.wav` | **REQUIRED** | .wav/.mp3/.m4a/.aac/.ogg · one file per scene · duration via ffprobe | ☐ |
| narration | `narration-0027` (Elder's Confirmation) | `narration/narration-0027.wav` | **REQUIRED** | .wav/.mp3/.m4a/.aac/.ogg · one file per scene · duration via ffprobe | ☐ |
| narration | `narration-0028` (Preparation) | `narration/narration-0028.wav` | **REQUIRED** | .wav/.mp3/.m4a/.aac/.ogg · one file per scene · duration via ffprobe | ☐ |
| narration | `narration-0029` (Offering) | `narration/narration-0029.wav` | **REQUIRED** | .wav/.mp3/.m4a/.aac/.ogg · one file per scene · duration via ffprobe | ☐ |
| narration | `narration-0030` (Spirit's Thanks) | `narration/narration-0030.wav` | **REQUIRED** | .wav/.mp3/.m4a/.aac/.ogg · one file per scene · duration via ffprobe | ☐ |
| narration | `narration-0031` (Relief) | `narration/narration-0031.wav` | **REQUIRED** | .wav/.mp3/.m4a/.aac/.ogg · one file per scene · duration via ffprobe | ☐ |
| narration | `narration-0032` (Village Praise) | `narration/narration-0032.wav` | **REQUIRED** | .wav/.mp3/.m4a/.aac/.ogg · one file per scene · duration via ffprobe | ☐ |
| narration | `narration-0033` (Arjun's Gaze) | `narration/narration-0033.wav` | **REQUIRED** | .wav/.mp3/.m4a/.aac/.ogg · one file per scene · duration via ffprobe | ☐ |
| narration | `narration-0034` (Mysterious Laughter) | `narration/narration-0034.wav` | **REQUIRED** | .wav/.mp3/.m4a/.aac/.ogg · one file per scene · duration via ffprobe | ☐ |
| narration | `narration-0035` (Unfinished Story) | `narration/narration-0035.wav` | **REQUIRED** | .wav/.mp3/.m4a/.aac/.ogg · one file per scene · duration via ffprobe | ☐ |
| flow_clips | `scene-0001` (Village Night) | `flow-clips/scene-0001.mp4` | optional | .mp4/.m4v · video+audio streams · >=640x360 · duration via ffprobe | ☐ |
| flow_clips | `scene-0002` (Arjun Alone) | `flow-clips/scene-0002.mp4` | **REQUIRED** | .mp4/.m4v · video+audio streams · >=640x360 · duration via ffprobe | ☐ |
| flow_clips | `scene-0003` (Mohans Arrival) | `flow-clips/scene-0003.mp4` | **REQUIRED** | .mp4/.m4v · video+audio streams · >=640x360 · duration via ffprobe | ☐ |
| flow_clips | `scene-0004` (Arjun Replies) | `flow-clips/scene-0004.mp4` | **REQUIRED** | .mp4/.m4v · video+audio streams · >=640x360 · duration via ffprobe | ☐ |
| flow_clips | `scene-0005` (Mohan Retreats) | `flow-clips/scene-0005.mp4` | optional | .mp4/.m4v · video+audio streams · >=640x360 · duration via ffprobe | ☐ |
| flow_clips | `scene-0006` (Clock Ticking) | `flow-clips/scene-0006.mp4` | optional | .mp4/.m4v · video+audio streams · >=640x360 · duration via ffprobe | ☐ |
| flow_clips | `scene-0007` (Arjun at Well) | `flow-clips/scene-0007.mp4` | optional | .mp4/.m4v · video+audio streams · >=640x360 · duration via ffprobe | ☐ |
| flow_clips | `scene-0008` (Well Whispers) | `flow-clips/scene-0008.mp4` | **REQUIRED** | .mp4/.m4v · video+audio streams · >=640x360 · duration via ffprobe | ☐ |
| flow_clips | `scene-0009` (Question Raised) | `flow-clips/scene-0009.mp4` | optional | .mp4/.m4v · video+audio streams · >=640x360 · duration via ffprobe | ☐ |
| flow_clips | `scene-0010` (Arjun Leans) | `flow-clips/scene-0010.mp4` | optional | .mp4/.m4v · video+audio streams · >=640x360 · duration via ffprobe | ☐ |
| flow_clips | `scene-0011` (Voice Pleads) | `flow-clips/scene-0011.mp4` | optional | .mp4/.m4v · video+audio streams · >=640x360 · duration via ffprobe | ☐ |
| flow_clips | `scene-0012` (Arjun Frightened) | `flow-clips/scene-0012.mp4` | **REQUIRED** | .mp4/.m4v · video+audio streams · >=640x360 · duration via ffprobe | ☐ |
| flow_clips | `scene-0013` (पहली रात) | `flow-clips/scene-0013.mp4` | optional | .mp4/.m4v · video+audio streams · >=640x360 · duration via ffprobe | ☐ |
| flow_clips | `scene-0014` (दूसरी रात) | `flow-clips/scene-0014.mp4` | optional | .mp4/.m4v · video+audio streams · >=640x360 · duration via ffprobe | ☐ |
| flow_clips | `scene-0015` (तीसरी रात) | `flow-clips/scene-0015.mp4` | optional | .mp4/.m4v · video+audio streams · >=640x360 · duration via ffprobe | ☐ |
| flow_clips | `scene-0016` (मोहन की चिंता) | `flow-clips/scene-0016.mp4` | optional | .mp4/.m4v · video+audio streams · >=640x360 · duration via ffprobe | ☐ |
| flow_clips | `scene-0017` (फोन नेटवर्क नहीं) | `flow-clips/scene-0017.mp4` | optional | .mp4/.m4v · video+audio streams · >=640x360 · duration via ffprobe | ☐ |
| flow_clips | `scene-0018` (बुजुर्ग से मुलाकात) | `flow-clips/scene-0018.mp4` | optional | .mp4/.m4v · video+audio streams · >=640x360 · duration via ffprobe | ☐ |
| flow_clips | `scene-0019` (अर्जुन का सवाल) | `flow-clips/scene-0019.mp4` | optional | .mp4/.m4v · video+audio streams · >=640x360 · duration via ffprobe | ☐ |
| flow_clips | `scene-0020` (बुजुर्ग की पुष्टि) | `flow-clips/scene-0020.mp4` | optional | .mp4/.m4v · video+audio streams · >=640x360 · duration via ffprobe | ☐ |
| flow_clips | `scene-0021` (दीपक और तुलसी) | `flow-clips/scene-0021.mp4` | optional | .mp4/.m4v · video+audio streams · >=640x360 · duration via ffprobe | ☐ |
| flow_clips | `scene-0022` (प्रार्थना) | `flow-clips/scene-0022.mp4` | optional | .mp4/.m4v · video+audio streams · >=640x360 · duration via ffprobe | ☐ |
| flow_clips | `scene-0023` (आवाज़ की शांति) | `flow-clips/scene-0023.mp4` | optional | .mp4/.m4v · video+audio streams · >=640x360 · duration via ffprobe | ☐ |
| flow_clips | `scene-0024` (मोहन की प्रशंसा) | `flow-clips/scene-0024.mp4` | optional | .mp4/.m4v · video+audio streams · >=640x360 · duration via ffprobe | ☐ |
| flow_clips | `scene-0025` (Village Elder) | `flow-clips/scene-0025.mp4` | optional | .mp4/.m4v · video+audio streams · >=640x360 · duration via ffprobe | ☐ |
| flow_clips | `scene-0026` (Spirit's Identity) | `flow-clips/scene-0026.mp4` | optional | .mp4/.m4v · video+audio streams · >=640x360 · duration via ffprobe | ☐ |
| flow_clips | `scene-0027` (Elder's Confirmation) | `flow-clips/scene-0027.mp4` | optional | .mp4/.m4v · video+audio streams · >=640x360 · duration via ffprobe | ☐ |
| flow_clips | `scene-0028` (Preparation) | `flow-clips/scene-0028.mp4` | optional | .mp4/.m4v · video+audio streams · >=640x360 · duration via ffprobe | ☐ |
| flow_clips | `scene-0029` (Offering) | `flow-clips/scene-0029.mp4` | optional | .mp4/.m4v · video+audio streams · >=640x360 · duration via ffprobe | ☐ |
| flow_clips | `scene-0030` (Spirit's Thanks) | `flow-clips/scene-0030.mp4` | optional | .mp4/.m4v · video+audio streams · >=640x360 · duration via ffprobe | ☐ |
| flow_clips | `scene-0031` (Relief) | `flow-clips/scene-0031.mp4` | optional | .mp4/.m4v · video+audio streams · >=640x360 · duration via ffprobe | ☐ |
| flow_clips | `scene-0032` (Village Praise) | `flow-clips/scene-0032.mp4` | optional | .mp4/.m4v · video+audio streams · >=640x360 · duration via ffprobe | ☐ |
| flow_clips | `scene-0033` (Arjun's Gaze) | `flow-clips/scene-0033.mp4` | optional | .mp4/.m4v · video+audio streams · >=640x360 · duration via ffprobe | ☐ |
| flow_clips | `scene-0034` (Mysterious Laughter) | `flow-clips/scene-0034.mp4` | optional | .mp4/.m4v · video+audio streams · >=640x360 · duration via ffprobe | ☐ |
| flow_clips | `scene-0035` (Unfinished Story) | `flow-clips/scene-0035.mp4` | optional | .mp4/.m4v · video+audio streams · >=640x360 · duration via ffprobe | ☐ |
| music | `background-music` | `music/background-music.mp3` | **REQUIRED** | audio · licence CC0 or CC-BY (+ attribution) · provenance music/background-music.license.json | ☐ |
| branding | `channel-intro` | `branding/channel-intro.mp4` | **REQUIRED** | MP4 · video+audio · duration via ffprobe | ☐ |
| branding | `channel-logo` | `branding/channel-logo.png` | **REQUIRED** | PNG signature valid | ☐ |

---

## 11. DO NOT SUPPLY

- screenshots of Flow UI
- browser screenshots
- images containing Flow labels
- character model sheets
- assets with accessibility / favourite / menu icons
- assets with browser chrome
- random stock assets that do not match the intended pipeline asset
- audio with unclear scene mapping
- clips without an audio stream
- clips whose duration is assumed rather than measured
- music with an unsupported/unknown licence
- files with path-traversal names

The validator remains authoritative.

---

## 12. Pre-flight checklist (future — NOT currently satisfied)

- [ ] All REQUIRED backgrounds supplied
- [ ] All REQUIRED characters supplied
- [ ] All REQUIRED narration supplied
- [ ] All REQUIRED scene clips supplied
- [ ] BGM supplied
- [ ] BGM licence metadata supplied
- [ ] Channel intro supplied
- [ ] Channel logo supplied
- [ ] Manifest pipeline SHA matches
- [ ] All hashes match
- [ ] No duplicate IDs
- [ ] No duplicate paths
- [ ] No invalid media
- [ ] No invalid licences
- [ ] No path violations
- [ ] Manifest status = `VALID`
- [ ] `production:check` reports scenes ready
- [ ] Project no longer `WAITING_FOR_INPUTS`

---

## 13. Execution gate

Production execution **MUST NOT** be attempted until **all** of the following hold:

1. manifest status = `VALID`
2. `production:check` reports all required scene inputs ready
3. required scene outputs are `CURRENT`
4. `--execute-stages` is explicitly supplied

There is **no automatic progression**, **no automatic asset download**, **no Flow fallback**,
and **no fake-input fallback**.
