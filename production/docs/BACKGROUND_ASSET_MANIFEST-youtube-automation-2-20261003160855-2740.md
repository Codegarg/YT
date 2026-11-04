# BACKGROUND ASSET MANIFEST

- Project id: `youtube-automation-2-20261003160855-2740`
- Story: YouTube Automation - रात के 2 बजे श्मशान से आती वो आवाज़
- Source of truth: `scripting/projects/youtube-automation-2-20261003160855-2740/pipeline.json` (verbatim; not assumed)
- Unique background tags: 7 (reused across 23 scenes)

## Existing validator requirements (production/src/assetCache.ts + sceneState.ts)
- Format: PNG (valid IHDR signature/decodable by the existing PNG dimension reader).
- Minimum resolution: **1280x720**; target **1376x768 or higher** (true 16:9 render target is 1920x1080 upscaled by the renderer).
- Aspect: 16:9-compatible, tolerance |w/h - 16/9| <= 0.09.
- Filename: exact tag stem + `.png` (safeTagStem strips the leading `#`), directly under
  `production/inputs/youtube-automation-2-20261003160855-2740/backgrounds/`.
- No weakening of validation. No placeholders. No people/characters, no text/logos/watermarks/UI.

## Tag-to-file map

| tag | filename | scenes using it | required size | current state |
| --- | --- | --- | --- | --- |
| #BGD-01-ARJUN-ROOM-WIDE | BGD-01-ARJUN-ROOM-WIDE.png | 1, 2, 4, 5, 6, 7 | PNG >=1280x720, 16:9 | MISSING |
| #BGD-02-ARJUN-ROOM-WINDOW-CLOSE | BGD-02-ARJUN-ROOM-WINDOW-CLOSE.png | 3, 22 | PNG >=1280x720, 16:9 | MISSING |
| #BGD-03-STREET-TO-CREMATION-WIDE | BGD-03-STREET-TO-CREMATION-WIDE.png | 8 | PNG >=1280x720, 16:9 | MISSING |
| #BGD-04-CREMATION-GROUND-WIDE | BGD-04-CREMATION-GROUND-WIDE.png | 9, 10, 11, 12, 20, 23 | PNG >=1280x720, 16:9 | MISSING |
| #BGD-05-CREMATION-GROUND-PYRE-CLOSE | BGD-05-CREMATION-GROUND-PYRE-CLOSE.png | 17, 18, 19 | PNG >=1280x720, 16:9 | MISSING |
| #BGD-06-CREMATION-GROUND-STONE-CLOSE | BGD-06-CREMATION-GROUND-STONE-CLOSE.png | 13, 14, 16 | PNG >=1280x720, 16:9 | MISSING |
| #BGD-07-ARJUN-HOME-INTERIOR-WIDE | BGD-07-ARJUN-HOME-INTERIOR-WIDE.png | 15, 21 | PNG >=1280x720, 16:9 | MISSING |

## Per-tag detail

### #BGD-01-ARJUN-ROOM-WIDE
- **Filename**: `BGD-01-ARJUN-ROOM-WIDE.png`
- **Location**: Arjun's Bedroom (Wide)
- **Look summary**: Simple Indian bedroom, window facing old cremation ground, night, teal-blue rainy light.
- **Scenes using it**: 1, 2, 4, 5, 6, 7
- **Required dimensions**: PNG, minimum 1280x720, 16:9-compatible (target 1376x768+).
- **Validation**: existing `assetCache` PNG/dimension/aspect checks + safe tag filename; no weakening.
- **Current state**: MISSING
- **Exact source prompt (verbatim pipeline `full_prompt`)**:

  > 2D semi-realistic cartoon illustration, bold clean outlines, smooth flat cel shading, Indian character and setting design, human-proportioned anatomy, realistic adult human head-to-body proportions, expressive detailed faces, moody teal-blue rainy night lighting, flat 2D vector art, no photorealism, no 3D, no CGI shading, no oversized head, no oversized body, no chibi or caricature proportions, no text, no watermark, --ar 16:9. Empty background plate of a modest North Indian bedroom at night, single bed, bookshelf, study table with lamp, window with view of old cremation ground's broken wall, rain-streaked glass, cool teal-blue atmosphere, practical streetlamp light pooling on wet floor tiles.

- **Generation-ready prompt (external generator, requested cinematic photorealistic horror, 16:9, >=1376x768)**:

  > Cinematic photorealistic horror photograph, Indian setting at night, moody teal-blue rainy atmosphere, wet reflective surfaces, volumetric fog and haze, practical streetlamp/teal glow, shallow depth of field, subtle film grain, high detail, 16:9 widescreen. No people, no characters, no animals, no text, no letters, no watermark, no logo, no UI, no labels. Clean empty plate with clear foreground/midground space for later character compositing. Empty background plate of a modest North Indian bedroom at night, single bed, bookshelf, study table with lamp, window with view of old cremation ground's broken wall, rain-streaked glass, cool teal-blue atmosphere, practical streetlamp light pooling on wet floor tiles.

### #BGD-02-ARJUN-ROOM-WINDOW-CLOSE
- **Filename**: `BGD-02-ARJUN-ROOM-WINDOW-CLOSE.png`
- **Location**: Arjun's Bedroom (Window Close)
- **Look summary**: Close-up of rain-streaked window, view to dark cremation ground.
- **Scenes using it**: 3, 22
- **Required dimensions**: PNG, minimum 1280x720, 16:9-compatible (target 1376x768+).
- **Validation**: existing `assetCache` PNG/dimension/aspect checks + safe tag filename; no weakening.
- **Current state**: MISSING
- **Exact source prompt (verbatim pipeline `full_prompt`)**:

  > 2D semi-realistic cartoon illustration, bold clean outlines, smooth flat cel shading, Indian character and setting design, human-proportioned anatomy, realistic adult human head-to-body proportions, expressive detailed faces, moody teal-blue rainy night lighting, flat 2D vector art, no photorealism, no 3D, no CGI shading, no oversized head, no oversized body, no chibi or caricature proportions, no text, no watermark, --ar 16:9. Empty background plate, close-up on rain-streaked window from inside a North Indian bedroom, faint silhouette of old cremation ground's broken wall and trees visible through glass, deep night, cool teal-blue atmosphere.

- **Generation-ready prompt (external generator, requested cinematic photorealistic horror, 16:9, >=1376x768)**:

  > Cinematic photorealistic horror photograph, Indian setting at night, moody teal-blue rainy atmosphere, wet reflective surfaces, volumetric fog and haze, practical streetlamp/teal glow, shallow depth of field, subtle film grain, high detail, 16:9 widescreen. No people, no characters, no animals, no text, no letters, no watermark, no logo, no UI, no labels. Clean empty plate with clear foreground/midground space for later character compositing. Empty background plate, close-up on rain-streaked window from inside a North Indian bedroom, faint silhouette of old cremation ground's broken wall and trees visible through glass, deep night, cool teal-blue atmosphere.

### #BGD-03-STREET-TO-CREMATION-WIDE
- **Filename**: `BGD-03-STREET-TO-CREMATION-WIDE.png`
- **Location**: Street Leading to Cremation Ground (Wide)
- **Look summary**: Deserted rainy night street, utility poles, wires, puddles, distant cremation ground gate.
- **Scenes using it**: 8
- **Required dimensions**: PNG, minimum 1280x720, 16:9-compatible (target 1376x768+).
- **Validation**: existing `assetCache` PNG/dimension/aspect checks + safe tag filename; no weakening.
- **Current state**: MISSING
- **Exact source prompt (verbatim pipeline `full_prompt`)**:

  > 2D semi-realistic cartoon illustration, bold clean outlines, smooth flat cel shading, Indian character and setting design, human-proportioned anatomy, realistic adult human head-to-body proportions, expressive detailed faces, moody teal-blue rainy night lighting, flat 2D vector art, no photorealism, no 3D, no CGI shading, no oversized head, no oversized body, no chibi or caricature proportions, no text, no watermark, --ar 16:9. Empty background plate of a narrow North Indian street at night, wet road reflecting streetlamp pools, closed shopfronts, utility poles and wires, puddles, distant view of old cremation ground gate and broken wall, cool teal-blue rainy atmosphere.

- **Generation-ready prompt (external generator, requested cinematic photorealistic horror, 16:9, >=1376x768)**:

  > Cinematic photorealistic horror photograph, Indian setting at night, moody teal-blue rainy atmosphere, wet reflective surfaces, volumetric fog and haze, practical streetlamp/teal glow, shallow depth of field, subtle film grain, high detail, 16:9 widescreen. No people, no characters, no animals, no text, no letters, no watermark, no logo, no UI, no labels. Clean empty plate with clear foreground/midground space for later character compositing. Empty background plate of a narrow North Indian street at night, wet road reflecting streetlamp pools, closed shopfronts, utility poles and wires, puddles, distant view of old cremation ground gate and broken wall, cool teal-blue rainy atmosphere.

### #BGD-04-CREMATION-GROUND-WIDE
- **Filename**: `BGD-04-CREMATION-GROUND-WIDE.png`
- **Location**: Old Cremation Ground (Wide)
- **Look summary**: Overgrown, broken-walled cremation ground, scattered pyres, banyan trees, mist, night.
- **Scenes using it**: 9, 10, 11, 12, 20, 23
- **Required dimensions**: PNG, minimum 1280x720, 16:9-compatible (target 1376x768+).
- **Validation**: existing `assetCache` PNG/dimension/aspect checks + safe tag filename; no weakening.
- **Current state**: MISSING
- **Exact source prompt (verbatim pipeline `full_prompt`)**:

  > 2D semi-realistic cartoon illustration, bold clean outlines, smooth flat cel shading, Indian character and setting design, human-proportioned anatomy, realistic adult human head-to-body proportions, expressive detailed faces, moody teal-blue rainy night lighting, flat 2D vector art, no photorealism, no 3D, no CGI shading, no oversized head, no oversized body, no chibi or caricature proportions, no text, no watermark, --ar 16:9. Empty background plate of an old North Indian cremation ground at night, broken brick walls, overgrown grass, scattered unused wooden pyres, ancient banyan trees, patches of mist, rain-soaked earth, cool teal-blue atmosphere.

- **Generation-ready prompt (external generator, requested cinematic photorealistic horror, 16:9, >=1376x768)**:

  > Cinematic photorealistic horror photograph, Indian setting at night, moody teal-blue rainy atmosphere, wet reflective surfaces, volumetric fog and haze, practical streetlamp/teal glow, shallow depth of field, subtle film grain, high detail, 16:9 widescreen. No people, no characters, no animals, no text, no letters, no watermark, no logo, no UI, no labels. Clean empty plate with clear foreground/midground space for later character compositing. Empty background plate of an old North Indian cremation ground at night, broken brick walls, overgrown grass, scattered unused wooden pyres, ancient banyan trees, patches of mist, rain-soaked earth, cool teal-blue atmosphere.

### #BGD-05-CREMATION-GROUND-PYRE-CLOSE
- **Filename**: `BGD-05-CREMATION-GROUND-PYRE-CLOSE.png`
- **Location**: Cremation Ground (Pyre Close)
- **Look summary**: Close-up of old wooden pyre, wet earth, mist, broken bangles on ground.
- **Scenes using it**: 17, 18, 19
- **Required dimensions**: PNG, minimum 1280x720, 16:9-compatible (target 1376x768+).
- **Validation**: existing `assetCache` PNG/dimension/aspect checks + safe tag filename; no weakening.
- **Current state**: MISSING
- **Exact source prompt (verbatim pipeline `full_prompt`)**:

  > 2D semi-realistic cartoon illustration, bold clean outlines, smooth flat cel shading, Indian character and setting design, human-proportioned anatomy, realistic adult human head-to-body proportions, expressive detailed faces, moody teal-blue rainy night lighting, flat 2D vector art, no photorealism, no 3D, no CGI shading, no oversized head, no oversized body, no chibi or caricature proportions, no text, no watermark, --ar 16:9. Empty background plate, close-up on an old wooden funeral pyre in a North Indian cremation ground at night, rain-soaked earth, scattered broken glass bangles, faint mist, cool teal-blue atmosphere.

- **Generation-ready prompt (external generator, requested cinematic photorealistic horror, 16:9, >=1376x768)**:

  > Cinematic photorealistic horror photograph, Indian setting at night, moody teal-blue rainy atmosphere, wet reflective surfaces, volumetric fog and haze, practical streetlamp/teal glow, shallow depth of field, subtle film grain, high detail, 16:9 widescreen. No people, no characters, no animals, no text, no letters, no watermark, no logo, no UI, no labels. Clean empty plate with clear foreground/midground space for later character compositing. Empty background plate, close-up on an old wooden funeral pyre in a North Indian cremation ground at night, rain-soaked earth, scattered broken glass bangles, faint mist, cool teal-blue atmosphere.

### #BGD-06-CREMATION-GROUND-STONE-CLOSE
- **Filename**: `BGD-06-CREMATION-GROUND-STONE-CLOSE.png`
- **Location**: Cremation Ground (Memorial Stone Close)
- **Look summary**: Close-up of weathered memorial stone, faint inscription, muddy ground, night.
- **Scenes using it**: 13, 14, 16
- **Required dimensions**: PNG, minimum 1280x720, 16:9-compatible (target 1376x768+).
- **Validation**: existing `assetCache` PNG/dimension/aspect checks + safe tag filename; no weakening.
- **Current state**: MISSING
- **Exact source prompt (verbatim pipeline `full_prompt`)**:

  > 2D semi-realistic cartoon illustration, bold clean outlines, smooth flat cel shading, Indian character and setting design, human-proportioned anatomy, realistic adult human head-to-body proportions, expressive detailed faces, moody teal-blue rainy night lighting, flat 2D vector art, no photorealism, no 3D, no CGI shading, no oversized head, no oversized body, no chibi or caricature proportions, no text, no watermark, --ar 16:9. Empty background plate, close-up on a weathered memorial stone half-buried in muddy ground, faint Hindi inscription, overgrown grass, rain droplets, cool teal-blue night atmosphere.

- **Generation-ready prompt (external generator, requested cinematic photorealistic horror, 16:9, >=1376x768)**:

  > Cinematic photorealistic horror photograph, Indian setting at night, moody teal-blue rainy atmosphere, wet reflective surfaces, volumetric fog and haze, practical streetlamp/teal glow, shallow depth of field, subtle film grain, high detail, 16:9 widescreen. No people, no characters, no animals, no text, no letters, no watermark, no logo, no UI, no labels. Clean empty plate with clear foreground/midground space for later character compositing. Empty background plate, close-up on a weathered memorial stone half-buried in muddy ground, effaced, illegible weathered carvings (no readable text or letters), overgrown grass, rain droplets, cool teal-blue night atmosphere.

### #BGD-07-ARJUN-HOME-INTERIOR-WIDE
- **Filename**: `BGD-07-ARJUN-HOME-INTERIOR-WIDE.png`
- **Location**: Arjun's Home Interior (Wide)
- **Look summary**: Simple North Indian home hallway, dim night, family photos, muted colors.
- **Scenes using it**: 15, 21
- **Required dimensions**: PNG, minimum 1280x720, 16:9-compatible (target 1376x768+).
- **Validation**: existing `assetCache` PNG/dimension/aspect checks + safe tag filename; no weakening.
- **Current state**: MISSING
- **Exact source prompt (verbatim pipeline `full_prompt`)**:

  > 2D semi-realistic cartoon illustration, bold clean outlines, smooth flat cel shading, Indian character and setting design, human-proportioned anatomy, realistic adult human head-to-body proportions, expressive detailed faces, moody teal-blue rainy night lighting, flat 2D vector art, no photorealism, no 3D, no CGI shading, no oversized head, no oversized body, no chibi or caricature proportions, no text, no watermark, --ar 16:9. Empty background plate of a modest North Indian home interior at night, hallway with family photos on wall, muted colors, dim teal-blue light from outside, simple furniture, tiled floor.

- **Generation-ready prompt (external generator, requested cinematic photorealistic horror, 16:9, >=1376x768)**:

  > Cinematic photorealistic horror photograph, Indian setting at night, moody teal-blue rainy atmosphere, wet reflective surfaces, volumetric fog and haze, practical streetlamp/teal glow, shallow depth of field, subtle film grain, high detail, 16:9 widescreen. No people, no characters, no animals, no text, no letters, no watermark, no logo, no UI, no labels. Clean empty plate with clear foreground/midground space for later character compositing. Empty background plate of a modest North Indian home interior at night, hallway with faded framed pictures on the wall rendered indistinct (no readable text, no in-focus faces), muted colors, dim teal-blue light from outside, simple furniture, tiled floor.

## Style conflict note
The pipeline `full_prompt` encodes a **locked flat, semi-realistic 2D Indian animation** style (per AGENTS.md / `scripting/style_reference.md`). The generation-ready prompts above use the requested **cinematic photorealistic horror** style. Using photoreal backgrounds with 2D characters is a deliberate visual divergence and should be confirmed before generating; the verbatim 2D prompt is provided above if style consistency is required.

## Reuse check
No valid assets for these tags exist locally (target inputs/backgrounds is empty). Existing PNGs under `production/inputs/raat-ka-khauf-3am-kuan/backgrounds/` belong to a different story (`BGD-01-VILLAGE-STREET-WIDE`, `BGD-02-WELL-AREA-WIDE`, `BGD-03-WELL-AREA-CLOSE`, `BGD-04-VILLAGE-ELDERS-HOUSE-INTERIOR`, `BGD-05-VILLAGE-STREET-CLOSE`) and do NOT map to these tags.