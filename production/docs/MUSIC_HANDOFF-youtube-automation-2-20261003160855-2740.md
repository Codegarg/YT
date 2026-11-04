# MUSIC HANDOFF — youtube-automation-2-20261003160855-2740

**Status: BLOCKED — one human decision required. Do not guess it.**

## Current state

The BGM file is installed and measured. Only the provenance sidecar is outstanding.

| Item | Value |
|---|---|
| Canonical audio | `production/inputs/youtube-automation-2-20261003160855-2740/music/background-music.mp3` |
| Size | 4,780,800 bytes |
| SHA-256 | `460AB38181F5FF94CDC44F417D2C2942D6390F3BE428A54A20D12F2431741F68` |
| Duration | 149.400000 s (`ffprobe format=duration`) |
| Audio | MP3, 48 kHz, stereo, 256 kbps; full decode passed |
| Track | Horror Suspense Tune — alex-morgan (Pixabay ID 579472) |
| Source URL | https://pixabay.com/music/orchestral-horror-suspense-tune-579472/ |
| Download timestamp | 2026-10-05T06:31:50Z (file `LastWriteTimeUtc`) |

## What is missing

`music/background-music.license.json` has **not** been created, on purpose.

The Pixabay contract (`production/src/pixabayBgm.ts`) requires `content_id_registered` to be an
explicit boolean that is **never inferred**. It fails closed with `CONTENT_ID_FLAG_MISSING` if the
field is absent, and it is never populated from a default.

## Why the value cannot be derived locally

Checked and confirmed empty:

- ID3 tags on the MP3 — **none at all** (Pixabay strips download metadata)
- Format tags — no artist, title, comment, copyright or ISRC
- Any existing provenance JSON — none
- Any `content_id` reference in the project — none

Content ID registration is a **YouTube-side Content ID database fact**. It is not derivable from
audio bytes, container metadata, or any local artifact. Pixabay licensing does not clear Content ID.

## Decision required

**Is Pixabay track 579472 registered in YouTube's Content ID system?**

Answer with exactly one of:

| Answer | Meaning | Result |
|---|---|---|
| `false` | Checked, or risk accepted | Sidecar written with `false`; music becomes **1/1** |
| `true` | It is registered | Sidecar written with `true`; validator **still accepts** it and attaches an advisory. You will probably prefer a different track |

## After the answer

The sidecar is written with these values — every one already measured or human-confirmed:

```json
{
  "provider": "pixabay",
  "title": "Horror Suspense Tune",
  "author": "alex-morgan",
  "source_url": "https://pixabay.com/music/orchestral-horror-suspense-tune-579472/",
  "license": "Pixabay Content License",
  "license_url": "https://pixabay.com/service/license-summary/",
  "attribution_required": false,
  "attribution_text": null,
  "content_id_registered": "<ANSWER>",
  "downloaded_at": "2026-10-05T06:31:50.000Z",
  "sha256": "460AB38181F5FF94CDC44F417D2C2942D6390F3BE428A54A20D12F2431741F68",
  "duration_seconds": 149.4
}
```

Then verify offline:

```
npm run production:check -- --project scripting/projects/youtube-automation-2-20261003160855-2740/pipeline.json
```

Expect `music: 1/1 valid`.

## Notes

- The BED stage normalises this track to **-20.9 LUFS**. Do not pre-normalise the file.
- Do **not** create `background-music.mp3.license.json`; the validator never reads that name and it
  would leave the canonical sidecar missing.
- `background-music.json` is **not** required by the Pixabay contract.
- The validator, the Pixabay contract and `content_id_registered`'s required-ness must **not** be
  relaxed to work around this.