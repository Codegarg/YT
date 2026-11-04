# Hindi Folk-Horror YouTube Automation Pipeline

This repository contains a two-half pipeline:

- `scripting/`: OpenAI-or-Groq API orchestration for idea -> script -> assets -> scenes -> publishing metadata.
- `production/`: Playwright browser automation for Google Flow using a persistent Chrome profile.

## Fastest local workflow: give one title

This is a local-only project. Nothing requires Railway or a cloud browser session. Copy `scripting/.env.example` to `scripting/.env`, add either your OpenAI or Groq key, ensure Chrome is logged into Google Flow, then run:

```powershell
.\start-video.ps1 -Title "आख़िरी बस की तीसरी सीट" -Concept "बरसाती रात में तीसरी सीट पर बैठी प्रेत-आत्मा"
```

`start-video.ps1` is a thin **compatibility wrapper**: it loads `scripting/.env` and delegates to the canonical workflow entrypoint `npm run video -- create` (run from `production/`), then prints the exact continuation commands. It does **not** itself run Flow, production stages, approval, or publishing. `npm run video -- <create|status|health|resume|approve|publish-status>` (in `production/`) is the single authoritative workflow; use `resume --run-flow --flow-session` only when Flow work is explicitly required.

The launcher creates a fresh **5-minute** project with about **35 structured scenes** (7 scenes per minute, 16:9). Override the target with `-Duration <minutes>` and/or `-Scenes <count>`. Flow itself decides every scene's natural duration; no scene is forced to six seconds. The Flow runner is resumable: it skips completed assets and retries pending/failed ones with exponential backoff (default 6-hour cap) before giving up.

### Writing-model selection

The scripting stages (idea, story, characters, backgrounds, scenes, and publishing metadata) automatically choose the first available local key:

1. `OPENAI_API_KEY` → OpenAI, default model `gpt-4.1-mini`.
2. `GROQ_API_KEY` → Groq, default model `openai/gpt-oss-120b`.

If both keys exist, OpenAI is used. Set `OPENAI_MODEL` or `GROQ_MODEL` in `scripting/.env` to override the default. Keys are never committed; `.env` is ignored by Git.

After Flow finishes, generate every listed narrator file in Google AI Studio. If Google AI Studio does not generate after two attempts, pause and ask the human to click **Run**. Put files in `production/outputs/<project>/narration/`, then run the final commands printed by the launcher. Character scenes retain their Flow audio unchanged. Narrator scenes use their Google AI Studio file, while scene ambience/SFX can remain quietly underneath.

## Important prompt-template contract

The prompt bodies from `HORROR PROMPTS.pdf` are now installed in `scripting/prompts/`. They remain stage-local and are rendered with only the named input substitutions. The supplied reference image is captured in `scripting/style_reference.md` and is appended as a locked style constraint for character, background, and scene generation.

If the templates are replaced or updated, keep the literal prompt wording intact and only change the `{{...}}` input fields:

```text
scripting/prompts/1- IDEA GENERATION.txt
scripting/prompts/3- STORY.txt
scripting/prompts/4- CHARACTER IMAGE PROMPTS.txt
scripting/prompts/5- IMAGE PROMPTS.txt
scripting/prompts/6- ANIMATION PROMPTS.txt
scripting/prompts/7- UPLOADING.txt
```

The runner refuses to start if a template is missing or still contains the old scaffold marker.

## Half A: scripting

```powershell
cd scripting
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
$env:OPENAI_API_KEY = "your key" # or set GROQ_API_KEY instead
python -m pipeline.cli new --project-id village-well --method B --concept "एक सूखे कुएँ में लौटती चूड़ैल" --ideas 5
python -m pipeline.cli choose --project projects\village-well\pipeline.json --index 2
python -m pipeline.cli run --project projects\village-well\pipeline.json --language Hindi --duration 8 --monster "चुड़ैल"
```

For a title-driven local project, run
`python -m pipeline.one_minute --project-id my-project --title "..." --duration 5 --scenes 35`
from `scripting/` with `OPENAI_API_KEY` (preferred) or `GROQ_API_KEY` set. The
default is a 5-minute, ~35-scene 16:9 project; `--duration` and `--scenes` let you
change those. The script batches scene generation internally so long projects do
not exceed the writing model's response limit. This creates a fresh project file;
do not rerun it over a project whose Flow assets are already in progress.

Provider calls retry rate limits (HTTP 429) and transient 5xx/network errors with
exponential backoff up to a default 6-hour cap; the Flow runner does the same for
pending/failed assets. Tune with `SCRIPT_RETRY_MAX_HOURS`, `SCRIPT_RETRY_BASE_SECONDS`,
`SCRIPT_RETRY_MAX_SECONDS`, `FLOW_MAX_RETRY_HOURS`, `FLOW_RETRY_BASE_MS`, and
`FLOW_RETRY_MAX_MS` (see `scripting/.env.example`).

`choose` is the only intentional Half A human checkpoint. `run` resumes completed stages and preserves the raw Stage 2 script as the source of truth. The generated project JSON follows `scripting/schema/pipeline.schema.json`.

Stage outputs may be JSON, fenced JSON, or the PDF's labeled text format. Parsers retain raw output and validate tags, minimum scene count, speakers, and the narrator/lip-sync split.

## SEO package (opt-in, publish-free)

A separate stage turns a finished story into a reviewable YouTube SEO package: three Hindi-first
title candidates with a recommendation and rationale, description, tags, hashtags, pinned
comment, thumbnail text/concept/image prompt, and three Shorts concepts with scene references.

```powershell
cd production
# generate for an existing project (writes only <project>\seo\)
npm run video -- seo --project "..\scripting\projects\<project-id>\pipeline.json"

# inspect the extracted facts and keyword plan without calling the model
npm run video -- seo --project "<pipeline.json>" --extract-only

# replace an existing package (the previous one is archived under seo\history\)
npm run video -- seo --project "<pipeline.json>" --regenerate
```

`npm run video -- create --title "..." --seo` runs the same stage right after story generation.
The stage never regenerates the story, never touches media or `pipeline.json`, never invents
search volume/difficulty/traffic figures, and never writes a timestamp the project data cannot
support. Exit codes: `0` success, `1` failure, `2` usage, `3` refused because a package exists.

Outputs land under `scripting\projects\<project-id>\seo\` (`seo-package.json`, `seo-package.md`,
`youtube-metadata.json`, `raw\`, `history\`). Review `seo-package.md`, then record explicit
approval of the title/description/tags mapping:

```powershell
npm run video -- seo --project "<pipeline.json>" --approve-metadata --yes --by "Your Name"
```

That approval is local bookkeeping only. The package is never uploaded, and the publisher
(`src/zernio.ts`) never reads it — applying the metadata stays a human step guarded by the
existing approval and publishing gates. Full design, validation rules and limitations:
[`docs/SEO_ENGINE.md`](docs/SEO_ENGINE.md).

## Half B: production

Install Playwright and its browser once:

```powershell
cd production
npm install
npx playwright install chrome
npm run flow -- --project ..\scripting\projects\village-well\pipeline.json --user-data-dir .\chrome-profile --output-dir .\outputs
```

The runner uses a persistent Chromium profile. On first use, complete Google login in the opened browser, then rerun. UI labels/selectors are centralized in `production/src/selectors.ts` and can be updated when Flow changes. It waits on DOM state and download events, not fixed render sleeps. The runner skips `done`, retries each `failed` item once, logs structured errors, and continues with later items.

This automation is intentionally conservative: it does not call a Flow API, create accounts, acquire credits, or clone voices.

> **Reusable Flow background/still-image generation is currently an EXTERNAL DEPENDENCY.**
> The current Flow UI is Agent-mediated and exposes no deterministic image-only path, so the
> production runner refuses to generate backgrounds. It fails closed with the explicit state
> `WAITING_FOR_EXTERNAL_BACKGROUND_INPUT` and machine-readable reason
> `CURRENT_UI_NO_DETERMINISTIC_IMAGE_PATH` (see `production/src/flowCapabilities.ts`).
> Agent-mediated generation is DISABLED and is never selected. Existing **locally supplied**
> (`production/inputs/<project-id>/backgrounds/<tag>.png`) and **cached** backgrounds are reused
> as-is. To re-enable Flow background generation later, implement the deterministic capability
> in `flowCapabilities.ts` only; runner orchestration does not change.

### Final edit with natural clip lengths and fades

Flow clips are never trimmed to a fixed duration. After downloading the completed `scene-####.mp4` files, preserve every clip in full and assemble them with short audio/video fades:

```powershell
cd production
npm run edit -- --input-dir .\outputs\youtube-automation-last-bus --output .\outputs\youtube-automation-last-bus\final-with-fades.mp4 --transition 0.35
```

The editor probes each clip's actual duration, keeps its full performance (including dialogue), then overlaps adjacent clips by the selected fade duration. The final runtime is content-driven, not fixed to the target length.

### Google AI Studio narration mix

Use the text and voice direction in `production/outputs/<project>/narration-manifest.json` (or the per-project `production/docs/NARRATION_HANDOFF-<project-id>.md`) to generate one narration file per listed scene in Google AI Studio. Supply each as `narration-000N.wav` (or `.mp3`/`.m4a`/`.aac`/`.ogg`) into the **project input** narration directory `production/inputs/<project-id>/narration/` — this is the only location the pipeline input validation reads narration from (it measures each file with ffprobe). Do NOT place narration in `production/outputs/<project>/narration/`; that path is not consumed by input validation. Pure dialogue scenes (character speakers) require a Flow video clip, not a narration file.

```powershell
cd production
npm run mix-narration -- --input-dir .\outputs\youtube-automation-last-bus --narration-dir .\outputs\youtube-automation-last-bus\narration --bgm .\outputs\youtube-automation-last-bus\background-music.mp3 --narration-makeup-db 12 --bgm-lufs -20.9 --output .\outputs\youtube-automation-last-bus\final-narrated.mp4 --transition 0.35
```

For every scene with a narration file, the mixer processes only the Google AI Studio narration through the tested speech-compression/limiter chain (approximately -14 LUFS) and retains low scene ambience/SFX beneath it. Character-dialogue scenes do not receive a narration file, so their native Flow voice remains untouched. The continuous background music is normalized to -20.9 LUFS. The same audio/video fade transition is applied between every scene, and clips use Flow's natural durations rather than a fixed length.

### Channel intro, music, and subtitle policy

Every final export starts with the first five seconds of the private channel intro at `production/assets/channel-intro.mp4`, then cross-fades into the titled story. Put a transparent `channel-logo.png` beside it. The logo is rendered on every final video in the lower-right reference position, inset from the edges (at 1280x720: 76px high, 72px from the right, 75px from the bottom). Both private assets are intentionally not committed; each clone must supply its own licensed copies.

The finishing commands printed by `start-video.ps1` download a Creative Commons Zero Freesound horror music bed and loop it continuously beneath the story at -20.9 LUFS. Narration is held around -14 LUFS after compression, which keeps it clearly intelligible. A 0 LUFS narration target is intentionally not used because it would clip speech. Set these local-only values in `scripting/.env` before the audio step:

```text
FREESOUND_CLIENT_ID=
FREESOUND_CLIENT_SECRET=
FREESOUND_REFRESH_TOKEN=
```

The music downloader saves a license record beside the downloaded file. Final FFmpeg exports map only video and audio, so soft subtitle streams are not carried into the completed video. The pipeline does not add subtitles. Burned-in captions or third-party watermarks must be avoided by obtaining a clean source export; they are not removed or concealed by this project.

### Read-only checks before approval

Two checks never write, never call a paid API and never upload. Run them before the approval questions:

```powershell
# 1. story/scene structure + repetition/opening/ending warnings (never writes pipeline.json)
cd scripting
.venv\Scripts\python.exe -m pipeline.one_minute --project-id your-project --check
cd ..\production

# 2. finished-render QA: 16:9, resolution, black/freeze frames, loudness, clipping (read-only)
npm run video -- qa --input outputs\your-project\final-title.mp4 --json
```

`--check` exits nonzero only for structural errors; story-quality observations are warnings. `qa` exits nonzero only for hard failures (unreadable container, wrong aspect, sub-minimum resolution, duration out of tolerance, clipping/true-peak at full scale). Neither command approves, publishes or changes a file.

See `docs/FUTURE_PIPELINE_OPTIMIZATION.md` for the full architecture audit, the target stage contract, and the documented (not yet implemented) improvements.

### Approval and optional YouTube publishing

The final title command printed by `start-video.ps1` includes `--project`. Once it finishes, the project enters `awaiting_approval` and asks two questions: “Should I approve this video?” and “Is it good to post on YouTube or not?” The answer is persisted in `pipeline.json`, so a later session can continue safely.

```powershell
cd production
npm run review -- approve --project ..\scripting\projects\your-project\pipeline.json
# or, if the result is not accepted:
npm run review -- reject --project ..\scripting\projects\your-project\pipeline.json
```

A rejection prints the follow-up question, “Should I regenerate the video?” No regeneration or publishing occurs automatically.

Zernio is optional and is used only after approval. Add a local `ZERNIO_API_KEY` to `scripting/.env` or your environment; the example value is intentionally blank and ignored by Git. Verify connected accounts with this read-only call:

```powershell
npm run zernio -- accounts
```

To show only YouTube accounts, add `--platform youtube`:

```powershell
npm run zernio -- accounts --platform youtube
```

The output contains safe fields only (`platform`, `accountId`, `displayName`, and `isActive`). It never prints credentials, authorization headers, raw response bodies, or signed URLs.

The publisher also requires a project-specific destination allowlist in `production/config/youtube-accounts.json`. That real file is local-only and ignored by Git; the committed `production/config/youtube-accounts.example.json` shows its shape. Copy the example to `production/config/youtube-accounts.json` and add an entry for each project:

```json
{
  "schema_version": 1,
  "projects": {
    "your-project": {
      "accountId": "YOUR_APPROVED_YOUTUBE_ACCOUNT_ID",
      "displayName": "Your channel"
    }
  }
}
```

This file contains only account IDs and display names. Never put API keys or tokens in it. The requested `--account-id` must exactly match the project's entry; a caller-supplied account ID cannot add, replace, or override an allowlist entry.

Before any R2 upload or publisher request, the publisher performs a read-only `GET /accounts?platform=youtube` check. It refuses to continue if the approved account is missing, is not a YouTube account, is inactive/disconnected, does not match the requested account, or the verification request fails. That verification is separate from the artifact approval and does not replace any approval, hash, review, visibility, synthetic-media, or confirmation gate.

For a standalone, read-only destination check before any upload or publish:

```powershell
cd production
npm run zernio -- preflight --project-id your-project --platform youtube
```

It reads the local allowlist, performs exactly one `GET /accounts?platform=youtube`, and prints only `projectId`, `platform`, `accountId`, `displayName`, `active`, and `preflight`. Success is `PASS`; failure prints a controlled `FAIL_<CODE>` (for example `FAIL_ACCOUNT_INACTIVE` or `FAIL_ACCOUNT_API_FAILURE`) and exits nonzero. It never uploads media, presigns a URL, changes review state, or publishes.

The approved RAAT KA KHAUF artifact is a **candidate** approval, so it must use the private-R2 `--media-file` flow below. The publisher rejects `--media-url` for candidate approvals before account verification, R2 service construction, upload, or any publisher request. A public URL would bypass the exact approved candidate path/hash, the R2 read-back hash check, and private presigned URL generation. Candidate approvals are also private-only: a non-private `--visibility` is refused before any upload or publisher call. The payload uses the allowlisted account ID, private visibility, and Zernio's synthetic-media disclosure (`containsSyntheticMedia: true`).

Canonical approvals may still use a publicly reachable media URL for public media. The command defaults to private visibility and requires a separate external-write confirmation. It never uploads or posts merely from a key being present.

### Private Cloudflare R2 media hosting

The publisher can upload the exact approved local candidate to a private R2 bucket and pass a short-lived presigned GET URL to Zernio in-process. The signed URL is never printed or accepted as a command-line argument.

Manual setup (the code does not create buckets, tokens, or public access):

1. Create a private R2 bucket.
2. Create an R2 API token scoped to **Object Read & Write** on that bucket only.
3. Add the values locally in `scripting/.env` (never commit them):

```text
R2_ACCOUNT_ID=
R2_ACCESS_KEY_ID=
R2_SECRET_ACCESS_KEY=
R2_BUCKET=
# Optional: default, eu, fedramp, or us
# R2_JURISDICTION=
# Optional: 3600..604800 seconds; default 86400
# R2_PRESIGN_TTL_SECONDS=86400
```

Do not enable an `r2.dev` subdomain, a public custom domain, or a public bucket policy. The object remains private; only the bearer URL is shared with Zernio.

After approval, the local-file publish path is:

```powershell
npm run zernio -- publish -- --project ..\scripting\projects\your-project\pipeline.json --account-id YOUR_APPROVED_YOUTUBE_ACCOUNT_ID --media-file .\outputs\your-project\final-title-no-logo-sparkle-candidate.mp4 --media-sha256 YOUR_APPROVED_SHA256 --title "Your title" --visibility private --confirm-publish YES
```

The account ID must match `production/config/youtube-accounts.json` for that project. The read-only account verification runs before the R2 service is created, so a missing, disconnected, mismatched, or unverifiable account causes a refusal with no upload and no publish request.

The command verifies the file hash against the approved artifact, writes `youtube-automation/<project-id>/<sha256>.mp4`, reads the object back to verify its SHA-256, and presigns a GET URL only after that verification. It refuses to overwrite a conflicting object. Add `--thumbnail-file path\to\thumbnail.jpg` to upload an optional JPEG/PNG/GIF thumbnail (maximum 2 MB) and attach it to the Zernio video media item.

Candidate approvals are private-R2-only. `--media-url` is rejected for them; use `--media-file` so the exact approved candidate and its SHA-256 stay in-process. For canonical approvals only, the public `--media-url` path remains available for media that is already publicly reachable. Do not pass a presigned R2 URL through `--media-url`; use `--media-file` so it stays in-process.

Zernio documents public, unauthenticated media URLs and its own media-presign flow. Third-party presigned URL compatibility is not explicitly guaranteed; validate it with a tiny test object and Zernio's media validator before a live publish. If it is rejected, use Zernio's documented media-presign flow rather than making the bucket public.

### Prepare media only (no Zernio or YouTube request)

`prepare-media` performs only the R2 half of the publish path: validate the local artifact, upload it privately, read it back, optionally probe the presigned URL, print safe metadata, and exit. It does **not** evaluate approval, verify the destination account, contact Zernio or YouTube, or change `approval.json`, `pipeline.json`, review state, or publishing state.

```powershell
cd production
npm run zernio -- prepare-media `
  --project-id your-project `
  --media-file .\outputs\your-project\final-title-no-logo-sparkle-candidate.mp4 `
  --media-sha256 YOUR_APPROVED_SHA256 `
  --confirm-r2-upload YES
```

Required arguments:

- `--project-id` — the project identifier. It must be a safe single path/key segment; `..`, absolute paths, and other unsafe IDs are rejected.
- `--media-file` — the exact local media file. It must resolve inside `production/outputs/<project-id>/`; missing files, directories, and `realpath` escapes (for example symlinks) are rejected. The MP4 `ftyp` header is checked, but codecs/container integrity are not fully validated.
- `--media-sha256` — the expected 64-character SHA-256. It is compared with the local file **before** any R2 request, so a mismatch aborts without uploading.
- `--confirm-r2-upload YES` — an explicit confirmation for this external storage write. Any other value is refused.

Optional arguments:

- `--probe-presigned-get` — after a successful read-back and presign, issue one in-process HTTP `GET` with `Range: bytes=0-0` through the generated URL. It does not follow redirects, aborts after 10 seconds, reads at most two response bytes, requires the returned byte to equal the first byte of the validated local MP4, and discards the URL and body immediately.
- `--outputs-root` — override the outputs root. When omitted, `OUTPUTS_ROOT` is used, falling back to `outputs` relative to the current directory (normally `production/outputs`).

Run `preflight` separately when you also want to confirm the destination account; `prepare-media` intentionally performs no Zernio request.

#### Authenticated read-back vs presigned probe vs Zernio retrieval

These are three different checks, and passing one does not prove the others:

| Check | Authentication | What it proves |
| --- | --- | --- |
| R2 read-back (`GetObject`) | S3 access key + secret | The stored object's bytes hash to the same SHA-256 as the local approved file. It proves storage integrity, not URL reachability. |
| Presigned GET probe (optional) | Bearer URL only | **This machine** can reach the private object through a presigned URL, the returned first byte matches the validated local MP4, and the ranged response reports the expected object size. It does not prove that another network can reach it. |
| Zernio publishing-worker retrieval | None (Zernio fetches the bearer URL) | Only what happens when Zernio actually ingests the URL during a publish. `prepare-media` never performs this, so it remains unproven until a real publish. |

The probe runs from the local machine and proves local outbound connectivity, URL validity, and the returned first-byte content. Zernio's worker runs elsewhere, may have different egress rules, and may apply its own media validation. A `PASS` probe is useful evidence, not a guarantee that Zernio will accept or retrieve the media.

The byte limit is enforced on bytes counted from stream chunks, not on the HTTP runtime's internal buffering. A single read may deliver more than one byte, and the runtime may buffer a network chunk; the probe still never requests another chunk and cancels the reader, so the full object is not downloaded.

**Successful R2 preparation does not mean Zernio or YouTube has accepted or published the video.** Preparation only stores and verifies bytes in a private bucket. Publishing remains a separate, gated operation that requires approval, account verification, the exact approved artifact path and hash, and explicit external-write confirmation.

#### Safe output and failure codes

On success the command prints exactly these nine metadata fields and exits `0`:

```json
{
  "projectId": "your-project",
  "objectKey": "youtube-automation/your-project/<sha256>.mp4",
  "bucket": "<configured bucket name>",
  "sha256": "<verified sha256>",
  "fileSize": 123456789,
  "contentType": "video/mp4",
  "presignGenerated": true,
  "presignedGetProbe": "PASS",
  "httpStatus": 206
}
```

- `presignedGetProbe` is `NOT_REQUESTED` without `--probe-presigned-get`, `PASS` for a valid one-byte `206`, and `FAIL` otherwise.
- `httpStatus` is the observed numeric status, or `null` when the probe timed out, failed at the network layer, or never ran.
- `presignGenerated: true` means the URL was created successfully. If the probe then fails, the command still reports `presignGenerated: true`, sets `presignedGetProbe: "FAIL"`, and exits nonzero because the URL could not be fetched. That URL is discarded either way.

On failure the command prints the same safe fields (with `null` where unknown), prints only a controlled code to stderr, and exits nonzero. Failure codes:

`CONFIRMATION_REQUIRED`, `INVALID_PROJECT_ID`, `INVALID_HASH`, `INVALID_FILE_PATH`, `UNSUPPORTED_FILE_TYPE`, `MISSING_CREDENTIALS`, `R2_CONFIG_INVALID`, `LOCAL_HASH_MISMATCH`, `UPLOAD_FAILED`, `READBACK_MISMATCH`, `PRESIGN_FAILED`, `PRESIGNED_GET_PROBE_FAILED`.

The command never prints, returns, or persists the presigned URL, credentials, request headers, response bodies, or raw provider errors. Credentials come from the environment or `scripting/.env` and are only reported by variable name when missing or malformed. A probe failure reports only `FAIL` and an optional numeric status, never the URL or the upstream body.

## Configuration

Set optional production environment variables:

```text
FLOW_URL=https://labs.google/flow
FLOW_PROJECT_NAME=Hindi Folk Horror
FLOW_IMAGE_MODEL=
FLOW_VIDEO_MODEL=
FLOW_RATE_LIMIT_MS=1500
ZERNIO_API_KEY=
R2_ACCOUNT_ID=
R2_ACCESS_KEY_ID=
R2_SECRET_ACCESS_KEY=
R2_BUCKET=
# R2_JURISDICTION=
# R2_PRESIGN_TTL_SECONDS=86400
FREESOUND_CLIENT_ID=
FREESOUND_CLIENT_SECRET=
FREESOUND_REFRESH_TOKEN=
```

Selectors are data, not logic. If Flow changes, update the selector candidates and the wait predicates in `production/src/flowClient.ts`.
