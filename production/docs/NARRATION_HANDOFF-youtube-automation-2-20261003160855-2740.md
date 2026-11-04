# youtube-automation-2-20261003160855-2740 — Narration Supply Handoff

**Status: narration NOT supplied. The project is `WAITING_FOR_INPUTS`.**

This document tells a human operator exactly which narration audio files to supply. Nothing
here is created automatically. Narration is generated OUTSIDE this repository (e.g. Google AI
Studio) and consumed read-only by the pipeline, which measures each file with ffprobe.

## 1. Exact directory

```
production/inputs/youtube-automation-2-20261003160855-2740/narration/
```

> This is the ONLY location the pipeline reads narration from. Do NOT use
> `production/outputs/<project>/narration/` (that path is not consumed by input validation).

## 2. Required files (exactly 16)

Filename contract: `narration-<4-digit scene number>.<ext>`, where `<ext>` is one of:

- Supported extensions: .wav, .mp3, .m4a, .aac, .ogg
- Recommended: `.wav`

```text
narration-0001.wav
narration-0002.wav
narration-0003.wav
narration-0006.wav
narration-0007.wav
narration-0008.wav
narration-0009.wav
narration-0010.wav
narration-0013.wav
narration-0014.wav
narration-0015.wav
narration-0016.wav
narration-0020.wav
narration-0021.wav
narration-0022.wav
narration-0023.wav
```

The same 16 scenes with an interchangeable extension (replace `.wav` with any supported extension): narration-0001.*, narration-0002.*, narration-0003.*, narration-0006.*, narration-0007.*, narration-0008.*, narration-0009.*, narration-0010.*, narration-0013.*, narration-0014.*, narration-0015.*, narration-0016.*, narration-0020.*, narration-0021.*, narration-0022.*, narration-0023.*

## 3. Files that MUST NOT be supplied as narration

These are PURE DIALOGUE scenes produced natively in Flow (they require Flow video clips, not narration):

- `narration-0004.*`, `narration-0005.*`, `narration-0011.*`, `narration-0012.*`, `narration-0017.*`, `narration-0018.*`, `narration-0019.*`

Do not add narration for scenes 4, 5, 11, 12, 17, 18, 19. Their audio is the character dialogue generated with the Flow clip.

## 4. Scene 15 (MIXED) — narration IS required

Scene 15 is `MIXED` (a narrator recount containing a quoted line). It requires `narration-0015.*` for readiness even though its source contains a quoted dialogue line. Its Flow video clip is OPTIONAL (not required).

## 5. Validation performed on each supplied file

- exact scene-number mapping from the filename (`narration-####`);
- supported extension (.wav, .mp3, .m4a, .aac, .ogg);
- unique mapping (a second file for the same scene → DUPLICATE, fail-closed);
- file exists and is a regular file;
- real duration measured by ffprobe (never inferred from text);
- duration must be positive and ≤ 600 s;
- invalid/ambiguous → INVALID / DUPLICATE (fail closed; nothing is substituted).

## 6. What happens after supply

- Each valid narration file resolves its scene duration (`durationProvenance = narration`).
- The 16 narration scenes transition from `WAITING_FOR_NARRATION` toward local-synthesis readiness.
- The 7 pure-dialogue scenes (4, 5, 11, 12, 17, 18, 19) remain `WAITING_FOR_VIDEO_CLIP` — they need Flow video, not narration.
- Scene 15 becomes narration-ready; its Flow clip stays optional.
- The project remains `WAITING_FOR_INPUTS` until the 7 dialogue Flow clips are also supplied.

## 7. Verify after supplying

```powershell
cd production
npm run production:check -- --project ..\scripting\projects\youtube-automation-2-20261003160855-2740\pipeline.json
```

Expected: `WAITING_FOR_NARRATION: 0`, `WAITING_FOR_VIDEO_CLIP: 7`, `INVALID: 0`, project still `WAITING_FOR_INPUTS`.
