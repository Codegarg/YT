# SEO Engine — RAAT KA KHAUF

An opt-in, publish-free stage that turns a finished story project into a reviewable YouTube
SEO package. It never regenerates a story, never touches video assets, and has no route to
the publisher.

---

## 1. Architecture

```
scripting/prompts/8- SEO.txt            literal prompt template (one JSON object)
scripting/pipeline/seo_keywords.py      channel profile + deterministic keyword taxonomy
scripting/pipeline/seo.py               extraction → prompt → parse → validate → package
scripting/pipeline/seo_test.py          offline test suite (mocked model, 307 checks)
scripting/schema/seo.schema.json        versioned JSON Schema (draft 2020-12) for the package
scripting/pipeline/prompts.py           registers the "seo" template key
production/src/seoGenerator.ts          thin TS boundary over the Python CLI
production/tests/seo_generator_test.mts offline tests for that boundary (81 checks)
```

Placement in the pipeline:

```
story generation → story validation → [SEO generation] → scene production → video
→ QA → review → approval → publishing
```

The SEO stage is **not** part of `one_minute.generate()`; it is a separate command that reads
`pipeline.json` read-only. That keeps the existing stages untouched and makes the engine
reusable for any project that already has a story.

**Provider reuse.** This repository has no Cloudflare Workers AI / Llama integration —
Cloudflare is used only for private R2 media hosting — so the SEO engine reuses the existing
provider-neutral `ScriptClient` (OpenAI when `OPENAI_API_KEY` is set, otherwise Groq). No new
paid dependency is introduced, and no key is ever read, printed or stored by the SEO code
beyond handing the unchanged environment to that client.

### Outputs

Everything is written inside the project's own directory, so it can never overwrite the
pipeline or any media:

```
scripting/projects/<project-id>/
  pipeline.json                     read-only input (never written)
  seo/
    seo-package.json                versioned machine-readable package
    seo-package.md                  human review document
    youtube-metadata.json           title/description/tags mapping (approval separate)
    raw/attempt-NN.txt              every raw model response (audit trail)
    history/generation-NNN-<stamp>/ immutable snapshot + manifest.json with sha256 of each file
    history/seo-package-genNNN-*    flat archive copies kept for older tooling
```

`scripting/projects/` is gitignored, so packages never enter version control.

---

## 2. How story information is extracted

`extract_story_facts()` builds the *only* permitted source of truth, deterministically and
read-only:

| Fact | Source |
|---|---|
| `title`, `hook` | `idea.selected`, falling back to the story's `**Title:**` / `**Tagline:**` lines |
| `entity` | the in-story supernatural character name (e.g. `राधा देवी की आत्मा`), **not** the creation-time `script.monster` archetype |
| `characters` + scene appearances | `characters[].tag` matched against each scene's asset tags |
| `settings` | `backgrounds[].location_name` |
| `scenes` | `scenes[].scene_number`, title, speaker → `scenes[N]` references |
| `acts` | `### Act N – NAME` headings in `script.raw_text` → `script.act:N` |
| `story_anchors` | grounded short Hindi phrases from entity, characters, title parts and scene titles |
| `digits` | numbers in the narrative only (act headings are stripped first) |
| `timing_available` | `false` unless every scene has a numeric duration |
| `source_index` | SHA-256 of the script text + counts/names, for traceability |

Missing story text or a missing scene list raises a hard input error **before** any model call.
Act headings are excluded from `digits`, so `Act 3 – ESCALATION` can never license the title
"रात के 3 बजे…".

---

## 3. How keywords are selected

`seo_keywords.py` holds a channel-level profile and taxonomy:

* **branded** — `raat ka khauf`, `रात का ख़ौफ़`, …
* **primary** — `hindi horror story`, `भूत की कहानी`, `डरावनी कहानी`, …
* **secondary** — `अमावस की रात`, `haunted village story hindi`, …
* **story-specific topic** — `chudail ki kahani`, `purani haveli horror story`, … promoted
  **only** when the story itself supports every marker word
* **story-specific** — derived from grounded story anchors only
* **long tail** — multi-word anchors + a search-shaped suffix

Two reusable gates run while the plan is built, and each rejection is recorded in
`keyword_plan_rejections` (package) / `plan["rejected"]` with a reason:

1. **Factuality gate.** `content_policy()` resolves the policy from the story metadata first and
   the channel profile second (unknown defaults to fiction). A fictional story never promotes a
   term that claims it is true/real/actual/verified ("सच्ची भूत की कहानी", "real story",
   "based on a true incident"). Plain genre vocabulary ("भूत की कहानी", "डरावनी कहानी",
   "ghost story hindi", "supernatural horror") stays. A documentary project can opt out by
   stating its policy in the story metadata — no engine edit needed.
2. **Topic gate.** A specific setting/creature/location term is promoted only when every marker
   word occurs in this story; otherwise it is rejected ("specific story topic absent from this
   story: haveli, …"). Broad genre discovery phrases are never over-filtered.

The same gates apply to tags, hashtags, titles, story keywords, the description, the pinned
comment and the thumbnail text.

Each record carries `heuristic_score` (0–100), a `priority` band, and
`priority_basis`:

> qualitative relevance estimate derived from story grounding, intent, language fit and
> audience fit; **NO search volume, keyword difficulty, ranking position or traffic data was
> measured, estimated or invented**

The score is a transparent ranking device built from four named inputs
(`story_relevance`, `search_intent`, `natural_language_fit`, `audience_fit`). It is not a
demand prediction, and no API is called to obtain any metric.

---

## 4. How titles are ranked and selected

The model proposes exactly three Hindi-first candidates with a hook type, the primary phrase,
source references and a one-line reason. `rank_title_candidates()` then scores each candidate
independently:

| Signal | Points |
|---|---|
| primary phrase appears in the first 40 characters | 25 (15 later in the title) |
| 40–75 characters (mobile readability) | 20 (12 for 76–90) |
| curiosity marker (`क्या`, `रहस्य`, `आवाज़`, …) | 10 |
| emotional marker (`डर`, `माँ`, `पुकार`, …) | 10 |
| a story-grounded number | 10 |
| ends with sentence punctuation | 3 |
| Devanagari present (Hindi-first) | 12 |

Phrase matching uses token-order containment, not an exact substring, so one inserted adjective
(for example `रहस्यमयी`) does not erase the search-phrase signal.

**The highest score wins.** Ties are broken by the shorter title (mobile readability), then by
the model's candidate order, so selection is deterministic and reproducible. The model's own
`recommended_title_index` is recorded in `title_selection.model_recommended_index` and audited;
it never overrides the ranking. A disagreement is a warning in the package, not a silent switch.

### Explicit editorial input

An optional `<project>/seo-editorial.json` (or `--editorial <path>`) may supply the title,
description, pinned comment, tags, hashtags and thumbnail. Every field goes through the same
story-grounding, content-policy and platform-limit checks as model output; the model's original
response remains in `seo/raw/attempt-*.txt`.

If the editorial title is already rank 1, the selection is recorded as `heuristic_top_rank` with
`editorial_confirmed: true` — it is a confirmation, not an override. If it is not rank 1, the
selection is recorded as `editorial_override`, and `title_selection.override` preserves the
requested title, its rank and score, the top-ranked title and score, the score gap and the
editor's reason. Scores and ranks are never rewritten, so the trade-off stays visible.

---

## 5. Description, tags, hashtags, thumbnail, Shorts

**Description** is validated structurally: non-empty, 300–5000 characters (the prompt targets
900–1800), contains an
explicit subscribe CTA, contains an engagement question, no invented numbers, and the final
line carries the validated hashtags (appended with a warning if the model forgot). Repeated
multi-word search phrases are flagged as possible keyword stuffing.

Prose grounding separates three vocabularies: story facts (hard), broad genre/taxonomy terms
(hard-allowed) and `NARRATIVE_VOCABULARY` — ordinary Hindi storytelling, CTA and genre words
such as `डरावनी`, `कहानी`, `जानिए`, `रोमांचित`, `भूतिया`, `स्वागत`. Those are language, not
facts, so they are not reported as invented story material; a genuinely new name, number or
fact still fails. When the content policy is fiction, a truth claim is a hard error and the
standard disclosure (`यह एक काल्पनिक कहानी है, केवल मनोरंजन के लिए।`) is inserted
deterministically in front of the hashtag line if the model omits it (recorded as a warning).
An upload-cadence promise ("हर हफ्ते", "every week") is a hard error unless the channel profile
explicitly confirms a schedule.

**Tags** are normalised, de-duplicated (Unicode-aware), length-capped per tag (30) and in total
(500 combined, YouTube's limit), and *dropped with a warning* when a token does not exist in
the story or the channel vocabulary, when it claims the story is true under a fiction policy,
or when it names an absent story topic. At least 8 must survive.

**Hashtags** must match `#[\u0900-\u097FA-Za-z0-9_]{2,40}`. A hashtag cannot contain a space, so
a multi-word tag is one token joined with underscores (`#अमावस_की_रात`); a spaced value
(`"#अमावस की रात"`), a missing leading `#`, or a whole inline list (`"#a,#b"`) is repaired into
separate single-token tags with a `rewrote ...` warning, never split into junk fragments.
Relevance is judged on a collapsed key (spaces/underscores/hyphens/camelCase removed), so
`#अमावस_की_रात`, `#RaatKaKhauf` and `#raat_ka_khauf` all compare like their plain forms, and a
tag survives when it is branded/channel, exists in the taxonomy, appears in the story corpus, or
is made of known words of which at least one is topical (a pure particle tag such as
`#the_story` is not). Unrelated trending tags (`#viralvideo`, `#trending`, `#cricket`) are
dropped with a warning; fewer than 3 survivors for the video is a hard error.

If the model returns no hashtag value at all (field absent, `null`, `[]`, or `""`), the engine
backfills a deterministic 3–4 tag set built only from the channel brand tag and short anchors
that already exist in the extracted story facts, re-checking every tag with the same relevance
rule and recording a warning. Supplied-but-rejected tags are **not** backfilled: "the model gave
us unrelated tags" stays a hard failure, so the validation is never weakened.

The two minimums in the error text are separate scopes, not a contradiction: `hashtags: need at
least 3 relevant hashtag(s) for the video` applies to the top-level array, and
`shorts_concepts[N].hashtags: need at least 1 relevant hashtag(s) for this Short` applies to one
Short. Each field reports at most one minimum error.

**Thumbnail** asks the model for 2–5 Devanagari words (the validator accepts 2–8, warns above 5
and rejects anything outside 2–8), all grounded in the story, plus main subject,
composition, background/lighting and colour/contrast guidance. The main subject must name an
actual story character/entity or setting; an invented character, creature or detail is a hard
error. The image prompt must name the story character (warning if it does not — consistency),
depict this story's setting, state the channel's 2D semi-realistic cartoon horror style, avoid
watermarks/logos, and end with `--ar 16:9`. It remains a prompt: nothing is rendered here.

**Pinned comment** is validated as prose: 40–600 characters, exactly one question, and it must
name a character, place or anchor from this story (a generic "share your story with us"
invitation is a hard error, with the filler phrase named in the warnings). Truth claims and
cadence promises are rejected under the same policy gates.

**Shorts** requires exactly three concepts, each with hook, title, description, 1–3 hashtags
(same format and relevance rules, capped at 5, with the same no-supply fallback), opening
narration line, CTA naming the full story, and `scene_refs` verified against real scene
numbers. **No timestamps are ever accepted**: a `0:15`-style value in any Shorts field is a
hard validation error, because the project data has no reliable timings. Each concept carries
`timing_note: "no timestamps: the story data contains no reliable scene durations"`.

---

## 6. Validation, parsing and failure semantics

Order of operations per attempt:

1. render the literal template (`scripting/prompts/8- SEO.txt`),
2. call the writing model (OpenAI if configured, else Groq — the existing `ScriptClient`),
3. write the raw response to `seo/raw/attempt-NN.txt`,
4. parse strictly (`parse_seo_json` tolerates fences and surrounding prose, nothing more),
5. validate deterministically,
6. on error, retry with a `REPAIR REQUIRED` block listing the exact failures.

Hard errors (they trigger a repair attempt): missing/empty fields, >100-character titles,
non-Devanagari titles, words not present in the story, invented numbers, missing CTA or
engagement question, malformed structure, short/long descriptions, wrong tag/hashtag counts,
too many thumbnail words, wrong Shorts count, timestamps, duplicate titles, a truth claim under
a fiction policy, an unsupported upload-cadence promise, a pinned comment with no story
reference, and a thumbnail that invents a character/creature or omits the channel style.

Warnings (never block; recorded in `validation_warnings`): description prose grounding,
style vocabulary in the image prompt, dropped unrelated/claim/absent-topic
tags/hashtags/keywords (including the rejection reason), repaired hashtag tokens and duplicate
removal, the grounded no-supply hashtag fallback, trimmed tag budget, appended aspect suffix or
hashtag line, an inserted fiction disclosure, a thumbnail prompt that never names the character,
a long thumbnail text, more than one pinned-comment question, generic pinned-comment filler, and
a heuristic/model title disagreement.

Bounded attempts: default **3** (one initial + two repairs), hard max **5**, override with
`--max-attempts` or `SEO_MAX_ATTEMPTS`.

Before anything is written, the assembled package is validated against
`scripting/schema/seo.schema.json` (JSON Schema draft 2020-12). That schema pins the required
fields, the 100-character title limit, the 500-character tag budget, the hashtag pattern, the
Shorts count, the `--ar 16:9` prompt suffix and the generation-metadata contract.

If every attempt fails, `SeoGenerationError` is raised **and no package is written** — a
directory only ever contains a `seo-package.json` that passed validation, satisfied the schema
and round-tripped through `json.loads`.

---

## 7. Running it

From `production/` (the canonical CLI):

```powershell
# generate for a project (writes <project>/seo/)
npm run video -- seo --project "..\scripting\projects\<project-id>\pipeline.json"

# by id, using the projects root
npm run video -- seo --project-id <project-id>

# inspect what would be sent to the model, no model call, nothing written
npm run video -- seo --project "<pipeline.json>" --extract-only

# bounded retries / model override
npm run video -- seo --project "<pipeline.json>" --max-attempts 2 --model <model-name>

# machine-readable result
npm run video -- seo --project "<pipeline.json>" --json
```

Opt-in during story creation (adds exactly one extra model round-trip, still no publishing):

```powershell
npm run video -- create --title "आख़िरी बस की तीसरी सीट" --seo
```

Equivalent Python entrypoint (used by the wrapper):

```powershell
cd scripting
.\.venv\Scripts\python.exe -m pipeline.seo --project "<pipeline.json>" [--regenerate] [--json]
```

Exit codes: `0` success · `1` failure · `2` usage · `3` refused because a package already
exists.

---

## 8. Reviewing, regenerating, approving

**Review** — open `seo/seo-package.md`. It contains the recommended title and all candidates
with character counts and heuristic scores, the full description, tags with the combined
character count, hashtags, pinned comment, thumbnail text/concept/prompt, every Shorts concept,
the keyword tables, all validation warnings, and a review checklist.

**Regenerate** — `--regenerate` archives the outgoing generation to
`seo/history/generation-NNN-<UTC stamp>/` (package JSON, review markdown, metadata mapping,
editorial input and the raw model attempts) with a `manifest.json` recording each file's byte
size and sha256, then increments `generation_metadata.generation`, records
`previous_package_sha256` and names the snapshot in
`generation_metadata.previous_generation_snapshot`. A flat
`seo/history/seo-package-genNNN-<stamp>.json|.md` copy is still written for older tooling.

Every generation is also snapshotted at creation, not only when a later run archives it. A later
regeneration verifies a byte-identical snapshot and reuses it; if the bytes differ (for example,
metadata changed after approval) it writes a new snapshot rather than overwriting history. A
recorded hash mismatch is a hard error, never silent data loss. Without `--regenerate` the
command refuses with exit code `3` and leaves the existing package byte-identical. Regeneration
only rewrites files under `seo/` plus the project-level `seo-editorial.json` input; media,
approval records and `pipeline.json` are never opened for writing.

Snapshots are what make an earlier generation verifiable after the working files are replaced:

```powershell
Get-Content seo/history/generation-001-<stamp>/manifest.json
```

**Approve the metadata mapping** (a separate, deliberate action):

```powershell
npm run video -- seo --project "<pipeline.json>" --approve-metadata --yes --by "Ridham"
```

This flips `seo/youtube-metadata.json` from `pending_review` to `approved`, stamps the approver
and timestamp, and refuses if the package has changed since the mapping was generated.
Approval is local bookkeeping only.

---

## 9. Using the metadata in YouTube Studio

`seo/youtube-metadata.json` maps:

* `youtube.title` ← `recommended_title`
* `youtube.description` ← `description`
* `youtube.tags` ← `tags`
* `youtube.visibility_recommendation` ← `"private"`

It is **documentation, not an automation hook**. The publisher (`production/src/zernio.ts`)
never reads it, and there is no code path from an SEO package to a Zernio or YouTube call.
To use it, copy the approved values into YouTube Studio (or into the existing publish command)
by hand, after the normal approval and publishing gates.

---

## 10. Guarantees

* No network publishing, no R2, no presign, no upload, no Zernio, no YouTube.
* No writes outside `<project>/seo/`; `pipeline.json` is opened read-only.
* No modification of any `.mp4`, `approval.json`, review record or publication record.
* No search volume / difficulty / ranking / traffic figures anywhere in the output.
* No timestamps when the source data has no reliable timings.
* No API keys, secrets or signed URLs in the package (asserted by test).
* A failed run writes no package, so failure can never look like success.

---

## 11. Known limitations

1. **No keyword demand data.** Priority is a relevance heuristic. Do not read the scores as
   volume, difficulty or expected traffic.
2. **Grounding is lexical.** A neutral paraphrase using vocabulary absent from the story is
   flagged (titles/thumbnail/pinned comment: hard error; description: warning). Very poetic
   Hindi may need a repair attempt.
3. **The whole script is sent as a prompt** (first 6 000 characters of the corpus excerpt plus
   structured facts). Very long stories are truncated for the model, though validation always
   runs against the full corpus.
4. **The title heuristic is not a CTR model.** It checks legibility and honesty signals only.
5. **Shorts get scene references, not timings.** Producing a Short still requires editorial
   judgement about which seconds to cut.
6. **The thumbnail prompt is text.** Rendering it remains a separate manual/Flow step.
7. **Metadata is never applied automatically**, by design. Applying it to a future publication
   stays a human action guarded by the existing approval and publish gates.
8. **Model output quality varies.** Malformed JSON is retried, but a stylistically weak (yet
   valid) package is possible; the review document exists for exactly that reason.
