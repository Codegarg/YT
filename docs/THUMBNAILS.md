# Thumbnails and Shorts covers (Phase 7)

Phase 7 adds two **separate** deliverables:

- the long-form YouTube thumbnail — **1280×720 (16:9)** under `outputs/<projectId>/thumbnail/`;
- one independent vertical cover per Short — **1080×1920 (9:16)** under
  `outputs/<projectId>/shorts/<shortId>/cover/`.

A cover is never a crop, resize or copy of the long-form thumbnail. Each owner has its own design,
its own sources, its own render key, its own QA report and its own approval.

Everything is rendered **offline** with FFmpeg + libass: a still from an already-rendered scene clip
(or a deterministic designed card when no clip exists), Devanagari type, and the channel logo at the
permanent lower-right position. No image-generation API, no Flow, no browser, no upload.

---

## 1. Concept ≠ design ≠ artifact

The three concerns are stored separately on purpose:

| Record | File | Contains |
| --- | --- | --- |
| **Concept** | inside `design.json → concept` | `headline`, `kicker`, `subhead`, `rationale`, `source_scene` — all derived from the story or an explicit override |
| **Design** | `design.json` | geometry only: dimensions, aspect, safe area, wrapped text blocks with positions/font sizes, palette, brand placement, sources, renderer settings, `design_hash` |
| **Artifact** | `thumbnail.png` / `cover.png` | the rendered PNG bytes |
| **Render evidence** | `render.json` | `render_key`, `design_hash`, `artifact_hash`, bytes, width/height, sources, `renderer_version`, `rendered_at` |
| **QA** | `qa.json` | hash-bound checks + pixel-measured ink boxes |
| **Approval** | `approval.json` | the human decision, bound to artifact hash + render key + QA report hash |

Editing a design re-renders the image. A changed video clip only invalidates the thumbnails/covers
that used that clip as a source.

## 2. Layout contracts

| | Long-form thumbnail | Short cover |
| --- | --- | --- |
| Dimensions | 1280×720 (16:9, tolerance 0.01) | 1080×1920 (9:16, tolerance 0.01) |
| Safe area (insets) | top 48 / right 64 / bottom 48 / left 64 | top 96 / right 86 / bottom 260 / left 86 |
| Type band | x 72, y 196, 1108×372 | x 96, y 240, 888×1240 |
| Kicker | 30 px, 1 line | 42 px, 1 line |
| Headline | 96 px, max 2 lines | 120 px, max 3 lines |
| Subhead | 36 px, max 1 line | 52 px, max 2 lines |
| Minimum headline / subhead | 64 / 30 px | 72 / 40 px |

The cover's larger bottom inset keeps type clear of the platform's rounded corners and bottom UI
strip. Wrapping uses a deliberately conservative width model (`TEXT_WIDTH_SAFETY_FACTOR = 1.08`), and
a block that cannot fit is flagged `overflow` — the design validator refuses it rather than drawing
type off-canvas.

Font: `Noto Sans Devanagari` (fontconfig/libass). If the font is missing, the text reference pass
detects zero ink and QA fails `thumbnail.text_ink.present` instead of silently shipping a blank image.

## 3. Concept derivation

- **Long-form** — headline = the story's own title (`publishing.data.title`, `idea.selected.title`,
  `script.title`, first scene title, then the project id). Subhead = the story hook/logline, truncated
  to one sentence. Visual = `representativeScene(pipeline)`: the **narrator** scene with the longest
  Hindi narration (lowest scene number breaks ties), so the still can never contradict spoken dialogue.
- **Cover** — headline = that Short's own title from `shorts-plan.json`. Subhead = that Short's own hook
  text. Visual = the Short's hook scene. rationale names the Short id, so no two covers read the same.
- Overrides (`--headline`, `--subhead`, `--kicker`, `--scene N`) replace one field at a time. Without
  overrides the output is deterministic for an unchanged story.
- Kicker default is the brand line `RAAT KA KHAUF • हिंदी लोक हॉरर`; the wordmark is also drawn as a
  always-visible brand element, and the logo box is separate from it (branding is never only text).

## 4. Sources and the permanent brand box

Sources are stored machine-independently, namespaced:

- `outputs:scene-0007.mp4` — a rendered scene clip in `outputs/<projectId>/`;
- `inputs:flow-clips/scene-0007.mp4` — a validated downloaded clip;
- `inputs:branding/channel-logo.png` — the channel logo.

Each entry records `role` (`base`/`logo`), `relative_path`, `sha256`, and for a clip `scene_number` +
`frame_seconds` (35 % into the clip, capped at 2.5 s). A clip is used only when `validateVideoClip`
reports `VALID`; otherwise the owner falls back to a **designed card** with a warning instead of
inventing imagery.

Brand box geometry (`brandPlacement(width, height)`, ratios 0.1056 / 0.05625 / 0.10417):

| Canvas | Box | Position |
| --- | --- | --- |
| 1280×720 | 76×76 px | x 1132…1208, y 569…645 |
| 1080×1920 | 203×203 px | x 816…1019, y 1517…1720 |

The box is square and anchored by its **right/bottom** edges at those insets, so the logo's aspect
ratio can never move it or push it off-canvas. The logo is *contained* inside the box
(`scale=…:force_original_aspect_ratio=decrease,pad`) — never stretched, never cropped.

## 5. Renderer

`THUMBNAIL_RENDERER_VERSION = 'thumbnail-renderer-2'` (part of every render key; bump it whenever the
graph or the ASS authoring changes).

Filter graph, in order:

1. scale-up (`force_original_aspect_ratio=increase`) + centre crop to the exact canvas, `setsar=1`;
2. grade: `eq=brightness=-0.12:saturation=0.95`, optional `vignette=angle=PI/5`;
3. a soft scrim (`palette.overlay @ 0.55`) behind the type band only, so Devanagari stays legible over a
   bright still without hiding the artwork;
4. `subtitles=thumbnail.ass` (libass, `WrapStyle: 2`, alignment 7 + `\pos`, PlayRes = canvas);
5. logo overlay inside the brand box;
6. `null` → one PNG frame (`-frames:v 1 -update 1`).

The ASS file is written next to the artifact and rendered with `cwd` = that directory so paths with
spaces work. QA re-renders the same graph twice more with the overlay stages swapped for transparent
content — a text-less pass and a logo-less pass — so the ink diff measures real type and real branding
rather than a pixel-format shift.

## 6. Deterministic keys, atomic writes, resume

- `thumbnailDesignHash(design)` — SHA-256 over everything except `created_at`/`design_hash`.
- `thumbnailRenderKey(design)` — SHA-256 over **renderer version + recomputed design hash + kind +
  canvas + font + frame seconds + background mode + every source's path and hash**. The stored
  `design_hash` field is never trusted, so a hand-edited `design.json` cannot keep an old key.
- Render is **atomic**: the new PNG is written to a temp file and renamed into place; on any failure the
  previous artifact is left untouched and no temp file survives.
- `render` is content-addressed: same render key + same bytes → `REUSED` (nothing written). A tampered
  or half-written artifact is re-rendered.
- Any changed source aborts the render with `source changed: <role>` instead of silently using stale
  pixels. Restoring the exact source bytes re-enables reuse.
- `status` is read-only and reports `planned` / `rendered` / `qa_failed` / `awaiting_approval` /
  `approved` / `stale` plus a `stale_reason` ("the design changed since the render", "the image bytes
  changed since the render", "source changed: base", …).

## 7. Commands

```powershell
cd production

# ---- long-form 1280x720 thumbnail ----
npm run video -- thumbnail plan   --project ..\scripting\projects\your-project\pipeline.json
npm run video -- thumbnail render --project ..\scripting\projects\your-project\pipeline.json
npm run video -- thumbnail status --project ..\scripting\projects\your-project\pipeline.json
npm run video -- thumbnail qa     --project ..\scripting\projects\your-project\pipeline.json
npm run video -- thumbnail approve --project ..\scripting\projects\your-project\pipeline.json --yes --sha256 <hash>

# ---- one cover per Short (independent design, render, QA, approval) ----
npm run video -- thumbnail plan   --project-id <projectId> --short short-01
npm run video -- thumbnail render --project-id <projectId> --short short-01
npm run video -- thumbnail qa     --project-id <projectId> --short short-01
npm run video -- thumbnail approve --project-id <projectId> --short short-01 --yes

# overrides / fallback
npm run video -- thumbnail plan --project <pipeline.json> --headline "कुएं की छाया" --subhead "रात 3 बजे" --scene 5
npm run video -- thumbnail plan --project <pipeline.json> --designed-card

# machine-readable
npm run video -- thumbnail status --project <pipeline.json> --json
```

`thumbnail status` without `--short` reports the long-form thumbnail **and** every cover listed in
`shorts/shorts-plan.json`. `--qa-warnings-block` makes WARNING-level QA evidence block approval.

## 8. QA

Pure design validation (`design.contract`, issue codes `design.*`) runs first: schema, dimensions,
aspect, safe area, minimum font sizes, text presence, Devanagari headline, overflow, contrast, brand
wordmark/placement, source recording, **and `design.hash` (a hand-edited design file fails)**.

Then the pixel/format checks:

| Check | Fails when |
| --- | --- |
| `thumbnail.present` | The PNG is absent |
| `thumbnail.signature` | The bytes are not a PNG |
| `thumbnail.hash` | The bytes differ from `render.json` |
| `thumbnail.dimensions` | Not exactly 1280×720 / 1080×1920 |
| `thumbnail.aspect` | Aspect is outside tolerance |
| `thumbnail.format` | The probe does not report PNG |
| `thumbnail.filesize` | Empty/suspiciously small, or above the envelope (2 MB long-form; 6 MB cover) |
| `thumbnail.render_key` | The recorded key is not reproducible from the design |
| `thumbnail.deterministic` | A second render is not pixel-identical |
| `thumbnail.text_ink.present` | Fewer than 300 ink pixels of type (silent font/text failure) |
| `thumbnail.safe_area.pixels` | The measured text ink box leaves the safe area |
| `thumbnail.branding.pixels` | No logo ink inside the recorded brand box |
| `thumbnail.independence` | A cover duplicates the long-form design **and** headline/source frame |

The report carries `artifact_hash`, `design_hash`, `render_key`, `report_hash`, measured `text_ink` /
`brand_ink`, `publishable: false` and `approval_required: true`. Re-running QA on identical inputs
writes nothing.

## 9. Approval

`approve` refuses unless **all** of the following hold:

- `--yes` was passed (approval is a human decision);
- a design, a render checkpoint and the artifact all exist;
- the artifact hash equals the checkpoint (and `--sha256`, when given);
- `thumbnailRenderKey(design)` still equals the recorded key (design unchanged since the render);
- `qa.json` exists, is not `FAIL` (and not `WARNING` with `--qa-warnings-block`), and still covers these
  bytes + this design + this owner.

The record stores `approved_artifact_path`, `approved_artifact_hash`, `approved_render_key` and the QA
`report_hash`/`generated_at`. Any byte change, design change or source change makes the approval
`STALE_APPROVAL`; once the same bytes are restored and re-QA'd, the identical approval validates
again without a new decision.

Approval is **per owner**: approving a cover never approves another cover, and never approves the
long-form thumbnail.

## 10. Independence and non-interference

- The long-form thumbnail and every cover have separate directories, designs, keys, QA and approvals.
- A long-form design change does not touch any video artifact, any Short render, or any other cover.
- A Short cover whose source frame changed is refused; the long-form thumbnail and other covers stay
  reusable.
- Narration changes never invalidate a thumbnail or cover (they consume no audio).
- Nothing in this layer writes to `pipeline.json`, SEO metadata, long-form media, `approval.json` or the
  Shorts artifacts themselves — `thumbnailStatus` explicitly reports `long_form_media_modified: false`.

## 11. Known limitations

- **No generative imagery.** The base is a real frame from a rendered clip or a deterministic card. The
  repo deliberately does not call an image model, so a "custom" thumbnail still comes from story frames.
- One still per owner at a fixed seek point (35 % in, capped at 2.5 s). There is no automatic
  best-frame search or face/subject detection.
- Composition is text-left over a graded still plus a scrim; there is no automatic focal-point aware
  cropping, arrow/circle annotation or expression selection.
- The safe-area pixel check validates the measured ink **box** of the type, not each glyph's kerning
  overshoot.
- Rendering depends on the Devanagari font being installed for libass. A missing font fails QA loudly
  (`thumbnail.text_ink.present`) instead of rendering tofu silently.
- Covers are not uploaded by this repo, so the file-size envelope is generous (6 MB); the long-form
  thumbnail keeps YouTube's 2 MB limit.
- Readability is enforced by minimum font sizes, contrast and overflow refusal — not by an OCR-based
  "can a human read this at 120 px?" judgement.
