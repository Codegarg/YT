# Character Asset Generation (off-Flow)

**The four character images have NOT been generated.** This document specifies exactly how they
must be produced and safely ingested when a human or an external provider supplies them.

- Canonical targets: `production/inputs/raat-ka-khauf-3am-kuan/characters/`
- Spec source: `production/src/characterGenerationSpec.ts`
- Adapter: `production/src/characterGenerator.ts`
- Dry-run: `npm run character-assets -- --dry-run`

---

## 1. Why Flow character assets cannot be reused

Steps **8DU/8DV** proved, with evidence, that the existing Google Flow character output is not a
usable local asset:

- The Flow character detail image is **cross-origin**; intrinsic canvas extraction fails with
  `SecurityError: Tainted canvases may not be exported`.
- Extracting it via the same-origin detail surface yields **1376×768** — **landscape**, below the
  character square requirement.
- Full alpha analysis: **alphaMin = alphaMax = 255, 0 % transparent** — a **100 % opaque model
  sheet** on a grey studio background.
- There is **no native Download/Export** action that produces a transparent cutout, and three of
  the four characters do not exist in the Flow project at all.

Therefore Flow is **not** an acceptable character source, and no screenshot, crop, background
removal, or model-sheet extraction will ever be accepted as a substitute.

---

## 2. The exact four character specifications

Derived from `pipeline.json` (source of truth). No profession is stated anywhere in the pipeline,
so **no profession is invented**.

| tag | name | age | gender/entity | personality | voice |
|---|---|---|---|---|---|
| `@CHAR-01-ARJUN` | अर्जुन | ~22 | male | calm, curious | Young male, native North Indian Hindi, calm and curious tone |
| `@CHAR-02-MOHAN` | मोहन | ~23 | male | anxious, hesitant | Young male, native North Indian Hindi, anxious and hesitant tone |
| `@CHAR-03-GEETA` | गीता | ~20 appearing | female supernatural entity / ghost | eerie yet calm | Female ghost/entity, native North Indian Hindi, eerie and haunting tone |
| `@CHAR-04-BUZURG` | बुजुर्ग | ~70 | male (elderly) | wise, calm | Elderly male, native North Indian Hindi, wise and calm tone |

**Physical appearance / clothing / expression / pose** for each are defined verbatim in
`characterGenerationSpec.ts` (`physical_appearance`, `clothing`, `expression`, `pose`).

---

## 3. Required image contract

Every generated asset must satisfy the **existing** `characterAsset.ts` contract:

| Rule | Requirement |
|---|---|
| Format | **PNG** (WebP only where genuinely supported) |
| Canvas | **square** — preferred 1536×1536 or 1024×1024 |
| Minimum | **≥ 1024 × 1024** |
| Aspect | square-ish (ratio within ±0.6 of 1.0) |
| Alpha | **REAL pixel transparency** — at least one pixel with `alpha < 255` |
| Content | exactly **ONE** complete character · full body · feet visible |
| Pose | neutral 3/4 standing reference pose |
| Exclusions | no second character · no props · no text/labels/UI · no model sheet · no turnaround · no multiple poses · no side/back views · no studio/coloured background · no border/frame · no watermark/logo |

Suitable for **1920×1080** FFmpeg alpha compositing.

> **Real pixel alpha is MANDATORY.** An RGBA PNG that is 100 % opaque is rejected as
> `CHARACTER_ASSET_NO_ALPHA` (hardened in 8DX).

---

## 4. Generation prompts

All four share one art direction:

> 2D semi-realistic Indian horror illustration, bold clean outlines, flat cel shading, subtle
> cinematic lighting, Indian visual design, expressive faces, polished digital illustration,
> consistent proportions and line quality

Each prompt ends with the universal requirements (full body, one character, neutral 3/4 pose,
feet visible, **fully transparent background with true alpha transparency**, square canvas, no
cropping, no model sheet, no studio/coloured background, no text/UI/border/watermark/logo).

The **exact** per-character prompts live in `characterGenerationSpec.ts` as
`generation_prompt` and are printed verbatim by `npm run character-assets -- --dry-run`.

## 5. Negative prompt

One shared negative prompt (embedded in every character's `negative_prompt`, with per-character
additions such as `facial hair` for the clean-shaven men, `gore, blood` for Geeta, and `scars`
for Buzurg):

> character sheet, turnaround sheet, multiple views, side view, back view, multiple characters,
> duplicate character, extra person, cropped body, cropped feet, missing limbs, extra limbs,
> extra fingers, deformed hands, text, typography, labels, captions, watermark, logo, UI,
> interface, frame, border, grey studio background, colored background, scenery, room, props,
> background objects, opaque background, white background, black background, gradient background,
> photographic realism, 3D render, anime, chibi, exaggerated cartoon proportions

---

## 6. Validation pipeline

`characterGenerator.ts`:
1. **Capability gate (fail-closed)** — refuses unless the provider guarantees PNG, a transparent
   background, a square size ≥1024, and does **not** declare that it may return opaque images.
2. **Produce** bytes (provider-specific; no provider is hard-coded here).
3. **Reject non-PNG** output — no automatic JPEG fallback.
4. **Temp write → validate** with the existing contract (signature/IHDR, dimensions, aspect,
   **real pixel alpha**) → **atomic rename**.
5. On failure: **delete the temp file**, leave any existing valid asset untouched, return a
   structured failure.

---

## 7. Canonical filenames

| tag | file |
|---|---|
| `@CHAR-01-ARJUN` | `characters/CHAR-01-ARJUN.png` |
| `@CHAR-02-MOHAN` | `characters/CHAR-02-MOHAN.png` |
| `@CHAR-03-GEETA` | `characters/CHAR-03-GEETA.png` |
| `@CHAR-04-BUZURG` | `characters/CHAR-04-BUZURG.png` |

## 8. How future generated assets are safely ingested

```ts
import { generateCharacterAssets } from './characterGenerator.js';
await generateCharacterAssets({
  outputDir: 'production/inputs/raat-ka-khauf-3am-kuan/characters',
  provider: myProvider,          // must satisfy the capability gate
  size: '1024x1024',
  transparentBackground: true,
  overwrite: false,              // never replace a valid asset unless explicit
});
```
Then verify: `npm run production:check -- --project <pipeline.json> --json` → `characters 4/4 valid`.

---

## 8a. OpenAI provider adapter (currently implemented)

`production/src/providers/openaiCharacterImageProvider.ts` implements the
`CharacterImageProvider` interface for **OpenAI image generation**.

- **OpenAI is the only implemented concrete provider.** No second provider exists.
- It requires an **explicitly configured image model** via `OPENAI_IMAGE_MODEL`. If the variable
  is absent the adapter returns `OPENAI_IMAGE_MODEL_NOT_CONFIGURED` — it never guesses a model.
- It uses the project's existing `OPENAI_API_KEY` convention. If absent it returns
  `OPENAI_IMAGE_PROVIDER_UNAVAILABLE` and makes **no request**. The key is never printed.
- **A text-model credential does not prove image capability.** Having `OPENAI_API_KEY` says
  nothing about whether the account/model can generate images.
- **Capability verification is mandatory and conservative.** PNG output, transparent background
  and the square `1024x1024` size are only reported as `VERIFIED` when the configured model is in
  an evidence list derived from the **installed SDK's own typings**
  (`openai/resources/images.d.ts` exposes `background: 'transparent'`, `output_format: 'png'`,
  `size: '1024x1024'`). Any other model → `OPENAI_IMAGE_CAPABILITY_UNVERIFIED`. Capabilities are
  **never inferred from a model name**, and **no request is made to discover them**.
- **`npm run character-assets -- --provider-check` is completely non-generative.** It loads
  configuration, checks the API key presence, the configured model, and the verified
  capabilities, and prints a `READY_FOR_GENERATION` / `BLOCKED: <CODE>` verdict. It never
  generates an image, never consumes image credits and never contacts Flow.
- **Actual assets are generated only in a separate, explicitly authorized step.** Nothing in this
  document claims the four images have been produced.
- Every generated asset must pass the existing **pixel-alpha validator** (8DX) before it is
  accepted; opaque output is rejected outright.
- **Flow is not used for character asset generation.**

> Current status: the adapter is **implemented**, but readiness depends entirely on
> `--provider-check` reporting `READY_FOR_GENERATION` for your configured model. If it reports
> `BLOCKED`, capabilities are unverified and no generation may proceed.

## 9. Explicit rules

- **Background removal is NOT an accepted substitute.** An opaque image is rejected outright; the
  generator never removes backgrounds.
- **Model sheets are NOT accepted.** They are excluded by the prompt and the negative prompt, and
  rejected by the contract.
- **Real pixel alpha is mandatory.** Colour type alone is never sufficient.
- **No Flow.** Flow character output is unrecoverable and must not be revisited.
