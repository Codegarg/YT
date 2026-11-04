# RAAT KA KHAUF — Future Production Pipeline Optimization

**Status:** audit complete; low-risk improvements implemented and tested; **no new video created, nothing published.**
**Date:** 2026-11-04
**Scope:** the *system*, not the finished video. The completed project (`youtube-automation-2-20261003160855-2740`) is treated as read-only reference material.

---

## 1. Guardrails honoured

| Guardrail | Evidence |
|---|---|
| `pipeline.json` never modified | SHA-256 `49215CEF6882F9656AACDFB5EDAE4D87FB958CE818BE18F584043A82CB1E7773` before and after the new read-only `--check` run, with an unchanged mtime |
| Approved SEO Generation 3 untouched | `seo/youtube-metadata.json` hash `661161CC393070D2C19EDD1EBB42F14A7DDF6719A21E0BC2EBA817BB455C9ABB`, snapshot `generation-003-20261103T163337Z` manifest `A922F5E440E0F466322A260AB7341E06C0D1070F4ACE15EF2E9FF52976656BDF`; no SEO command was run |
| Production outputs untouched | `final-title.mp4` SHA-256 `DA6C258E14A550C8867366599B7786C04684F367546B2FED688BD7F70976EE1C`, unchanged after the QA probe (in-place hash re-check) |
| No upload / publish / visibility change | no publisher, Zernio or YouTube call was made; `publish-status` is read-only and reported `PUBLISH_BLOCKED_NOT_APPROVED` |
| Historical generations preserved | no file under `seo/history/` was read-modified, moved or deleted |
| Nothing committed | all work remains in the working tree |

> **Operator note (must be confirmed by hand, not by code):** `pipeline.json` carries a legacy `review` block with `"status": "posted"` and `"posted_at": "2026-11-01T07:56:30.026Z"`. That makes `publish-status` report `REVIEW_POSTED` and **block** publishing (`publishable: false`). YouTube visibility cannot be checked offline, so confirm the video is still **Private** in YouTube Studio. No code in this change set touches that field.

---

## 2. Executive summary

The repository already contains a serious, safety-first system: atomic writes, immutable SEO snapshots, integrity-bound approval, credit-gated Flow generation, reference-locking prompts and a resumable runner. The weaknesses are mostly **operational** (untracked modules, duplicated legacy entrypoints, manual narration, no media QA) rather than architectural.

Highest-value findings, in order:

1. **The finished render was never machine-checked for audio clipping or black/freeze frames.** The new probe finds **50 full-scale samples / −0.3 dBFS true peak** in the existing `final-title.mp4`. (Report only — the file was not touched.)
2. **Roughly half the production code and test suite is untracked** (`production/src/*`, `production/tests/*`, `scripting/pipeline/seo*.py`, …). A clean clone cannot run the pipeline.
3. **`npm run flow` did not take the shared session lock**, so it could race the canonical workflow and drive the same Chrome profile twice. Fixed.
4. **TITLE stage-key provenance omits the effective title** when no explicit title is passed, so a fallback-title change could reuse a stale render. Documented, not changed (changing it would invalidate the completed project's recorded TITLE key).
5. **No read-only pre-Flow story gate.** Structural story/scene defects are only discovered after generation starts. Added `--check`.
6. **The `generationAlreadyAttempted` guard is dead code** and arming it naively would break documented retry semantics. Documented with a safe design.

---

## 3. Current architecture (as actually wired)

### 3.1 Entrypoints

| Command | Authority | What it does |
|---|---|---|
| `.\start-video.ps1 -Title …` | wrapper | loads `scripting/.env`, calls `npm run video -- create`, prints continuation commands |
| `npm run video -- create` | `production/src/video.ts` | story/characters/backgrounds/scenes via Python, then stops at `CREATED` |
| `npm run video -- resume` | `projectWorkflow.ts` | single resumable authority; zero-credit unless `--run-flow` |
| `npm run video -- status / health / publish-status` | read-only | derived state, never executes stages or network paths |
| `npm run video -- approve` | `approval.ts` | integrity-bound human approval (`--yes`, optional `--sha256`) |
| `npm run video -- seo` | `seoGenerator.ts` → `scripting/pipeline/seo.py` | SEO package/history/approval; never publishes |
| `npm run flow` | `production/src/cli.ts` | direct Google Flow runner (characters → backgrounds → scenes) |
| `npm run production:check` | `prodCheck.ts` | input manifest, downstream plan, optional guarded stage execution |

### 3.2 Stage map

```
STORY (one_minute.py)
  └─ characters / backgrounds / scenes (same model call path)
CREATE ──► pipeline.json + assets
RESUME ──► projectWorkflow
            ├─ FlowRunner  ──(lock)──► npm run flow ──► cli.ts ──► Flow/Chrome
            ├─ SceneExecutor ──► sceneFlowWorkflow ──► checkpoints
            └─ productionOrchestrator
                 EDIT  → final-with-fades.mp4
                 MIX   → final-narrated.mp4      (mixFilterGraph = single source of truth)
                 BED   → final-bedded.mp4        (licensed BGM, −20.9 LUFS bed)
                 TITLE → final-title.mp4         (intro + logo + 3.7 s title card)
                 APPROVAL → approval.json / review state
SEO → seo/youtube-metadata.json (+ immutable history generations)
PUBLISH (manual, gated) → zernio.ts → YouTube
```

### 3.3 Component inventory (live path only)

| Area | Canonical module | Reuse / notes |
|---|---|---|
| Story, characters, backgrounds, scenes | `scripting/pipeline/one_minute.py` | all validation + prompt hardening lives here |
| Prompt safety | `prompt_safety.py`, `voice_selector.py` | deterministic, offline |
| Flow orchestration | `projectWorkflow.ts` → `flowRunnerAdapter.ts` | session lock, zero-credit default |
| Flow execution | `cli.ts` → `runner.ts` → `flowClient.ts` | resumable, retry/backoff |
| Scene decisions | `sceneFlowWorkflow.ts` (`decideSceneAction`, checkpoints) | pure decision + atomic checkpoint |
| Media contract | `videoClip.ts`, `sceneRenderer.ts` | ffprobe validation, deterministic normalisation |
| Audio | `narrationDurationPolicy.ts`, `mixFilterGraph.ts`, `narrationTts.ts` | shared duration policy, single mix graph |
| BGM | `bgm.ts`, `pixabayBgm.ts`, `freesound.ts`, `inputManifest.ts` | licence gating |
| Branding/title | `titleGraph.ts`, `addTitle.ts` | one canonical branding source |
| QA/health | `prodCheck.ts`, `projectHealth.ts`, **`mediaQa.ts` (new)** | advisory vs fail-closed checks |
| Approval/publish | `approval.ts`, `approvalReview.ts`, `publishLock.ts`, `zernio.ts` | integrity-bound, no auto-publish |

---

## 4. What is already strong (keep it)

| Strength | Where | Why it matters |
|---|---|---|
| Atomic writes (`tmp` + rename) | `models.save`, checkpoint/state writers | no half-written project or checkpoint |
| Immutable SEO snapshots + manifests | `seo.py`, `seo/history/` | regeneration cannot rewrite an approved artifact |
| Integrity-bound approval | `approval.ts` | approval names an artifact hash, not "latest file" |
| One-way publishing gate | `publishLock.ts`, `zernio.ts` | no automatic public release; ambiguous outcomes fail closed |
| Explicit generation permission | `allowGeneration`, `--run-flow` | every Flow credit is deliberately authorised |
| Scene checkpoints with provenance | `sceneFlowWorkflow.ts` | resume/download never regenerates a committed scene |
| Reference locking | `appearance_lock` + `wardrobe` + prompt hardening | character consistency without burning credits on retries |
| Shared duration policy | `narrationDurationPolicy.ts` | renderer and mixer cannot disagree |
| Single mix graph | `mixFilterGraph.ts` | timing/filters are unit-testable without rendering |
| Flow download validation | `downloadCommittedSceneClip` + `validateVideoClip` | no empty/corrupt clip enters the edit |
| Licence gating | `inputManifest.ts` | unlicensed music fails closed |

---

## 5. Weaknesses and bottlenecks

Severity: **H** = can lose money/artifacts, **M** = creates manual work or bad reports, **L** = hygiene.

| # | Sev | Finding | Evidence | Consequence |
|---|---|---|---|---|
| 1 | H | Most production modules and tests are **untracked** | `git status`: `?? production/src/*`, `?? production/tests/*`, `?? scripting/pipeline/seo*.py` | a clean clone cannot create or resume a video |
| 2 | H | `npm run flow` bypassed the shared Flow session lock | `cli.ts` started Chrome before any lock; `flowRunnerAdapter` holds the lock around the child | two runners can share one Chrome profile → wrong project/scene attachment, lost credits |
| 3 | H | No automated media QA on the finished file | no `blackdetect`, `freezedetect`, `ebur128` or `volumedetect` anywhere | clipping/black/freeze defects reach a human review or YouTube |
| 4 | M | TITLE stage key ignores the **effective** title | `prodCheck.ts` sets `titleMetadata` only when `titleAssets.title` is defined; `addTitle.ts` has a hardcoded default | a fallback-title edit can be considered "CURRENT" → stale title card |
| 5 | M | `generationAlreadyAttempted` is always `false` | `sceneFlowWorkflow.ts` `processSingleFlowScene` | the only in-code duplicate-generation guard never fires |
| 6 | M | No story/scene gate before Flow | `one_minute.py` validates during generation only | a structurally broken project spends model calls before it fails |
| 7 | M | Two parallel Python stage implementations | `cli.py` / `stages.py` vs `one_minute.py` (hardcodes `2/35`) | drift; every fix must be made twice |
| 8 | M | Narration depends on manual Google AI Studio runs | `AGENTS.md` operator rule; no API path in-repo | the single largest human bottleneck in wall-clock time |
| 9 | M | Thumbnail workflow is manual and not in the stage graph | no thumbnail module; SEO generates metadata only | branding/readability review is ad hoc |
| 10 | L | Hardcoded legacy defaults in stage CLIs | `addTitle.ts` (`outputs/last-bus-*`, `AAKHRI BUS KI TEESRI SEAT`), `cli.ts` (`../scripting/projects/example/pipeline.json`) | a mis-typed manual command can write to a non-project path |
| 11 | L | Pinned mutable-state tests | `prompt_hardening_test.py` pins `pipeline.json` SHA; `flow_prompt_hardening_test.mts` asserts "not approved"; `test_paths_resolution_test.mts` pinned 96 files | permanent red tests hide real regressions |
| 12 | L | Static project-name default | `flow_project_name = f"YouTube Automation - {(title or 'Last Bus')[:48]}"` | only affects paths without a title |
| 13 | L | `json_object()` and `parse_jsonish()` duplicate extractors | `one_minute.py`, `anthropic_client.py` | different error text for the same failure |

### Verified non-issues (audit claims that did **not** hold)

- The `--title` path does **not** pay for a discarded idea-generation call: `one_minute.py` already skips the ideas call when a title is supplied and only asks for a one-sentence hook. Nothing to remove.
- The mix stage already has a single graph/timing source of truth (`mixFilterGraph.ts`), so no de-duplication is needed there.
- Flow download/commit verification is already fail-closed and prefers DOWNLOAD over GENERATE; it must not be "simplified".

---

## 6. Improvements implemented (this change set)

### 6.1 Read-only media QA probe — `video qa`

- **New:** `production/src/mediaQa.ts` (pure parsers + policy, I/O only for decode).
- **New command:** `npm run video -- qa --input <file> [--json]`.
- Checks: container/stream validity, **16:9** aspect, minimum/target resolution, expected duration, **black frames**, **freeze frames**, **integrated loudness (EBU R128)**, **true peak**, **sample clipping** (`histogram_0db`).
- Guarantees: every ffmpeg pass writes to `-f null -`; no render, no transcode, no rename, no delete, no network, no Flow.
- Severity policy: hard FAIL only for unusable container, wrong aspect, sub-minimum resolution, duration out of tolerance, true peak ≥ −0.1 dBFS, clipped samples > 0. Black/freeze/loudness drift are **WARN** because fades and stylised holds are legitimate and a human decides.
- Branding/logo detection is **explicitly skipped** and reported as skipped (needs vision/OCR); it is never silently assumed clean.
- Measured on the completed render (read-only, hash verified unchanged): `1280x720`, `212.967 s`, 0 black segments, 0 freeze segments, **I = −12.6 LUFS**, LRA 8.6 LU, true peak −0.3 dBFS, **50 clipped samples** (`AUDIO_CLIPPING`), `BELOW_1080P_TARGET` warning. Probe runtime **7.96 s** for a 3.5-minute 720p file.

### 6.2 Flow CLI session-lock handshake

- **New:** `production/src/flowCliLock.ts` (pure): owns the `FLOW_SESSION_LOCK_HELD` contract, the "should I acquire?" decision and the child environment.
- `cli.ts` now runs its whole browser session under `withFlowSessionLock(...)` when it is standalone.
- `flowRunnerAdapter.ts` passes `FLOW_SESSION_LOCK_HELD=1` to the child it already locks, so the non-reentrant lock is not re-acquired (no deadlock).
- Default behaviour when the flag is missing/malformed is **acquire**, i.e. fail safe. The lock root defaults to the invocation directory and honours `FLOW_LOCK_ROOT`.

### 6.3 Read-only story/scene gate — `--check`

- **New:** `scripting/pipeline/project_check.py`; `one_minute.py --check` delegates to it.
- **Errors** (exit 1): canonical structure (`validate()` on a deep copy), scene count, missing narration.
- **Warnings** (still exit 0): weak opening (< 40 characters of scene-1 speech), repeated spoken lines, silent ending, word-count drift from the duration target, unspecified character attributes, duplicate display names, unused backgrounds/characters.
- Read-only by construction: the project is deep-copied before `validate()` (which normalises prompts), no `save()`, no model call. Verified against the real project: byte-identical file and mtime.
- Tolerates a UTF-8 BOM and returns structured `PROJECT_NOT_FOUND` / `PROJECT_UNREADABLE` reports instead of tracebacks.

### 6.4 Test-maintenance corrections (behaviour-preserving)

- `scene_executor_dispatch_test.mts`: the ownership allowlist assertion now reflects the **six** statuses actually shipped (the two `SCENE_LOCAL_*_COMPLETE` statuses were added later), plus new positive/negative checks. Comment in `sceneExecutorAdapter.ts` corrected ("four" → allowlisted).
- `test_paths_resolution_test.mts`: the migrated-file count is now a **lower bound** (`>= 96`) so additive regression tests are allowed while accidental deletion is still caught.

### 6.5 Files added / changed by this work

| File | Change |
|---|---|
| `production/src/mediaQa.ts` | **new** read-only QA probe + pure parsers/policy |
| `production/src/flowCliLock.ts` | **new** lock handshake contract |
| `production/src/video.ts` | `qa` subcommand + usage text |
| `production/src/cli.ts` | session lock around the whole browser run |
| `production/src/flowRunnerAdapter.ts` | child environment carries the held flag |
| `production/src/sceneExecutorAdapter.ts` | comment only |
| `scripting/pipeline/project_check.py` | **new** read-only audit |
| `scripting/pipeline/one_minute.py` | `--check` flag (import is lazy) |
| `production/tests/media_qa_test.mts` | **new** 37 checks |
| `production/tests/flow_cli_lock_test.mts` | **new** 20 checks |
| `scripting/pipeline/project_check_test.py` | **new** 25 checks |
| `production/tests/scene_executor_dispatch_test.mts` | allowlist correction |
| `production/tests/test_paths_resolution_test.mts` | lower-bound count |
| `docs/FUTURE_PIPELINE_OPTIMIZATION.md` | this document |

No feature was removed; every change is additive or a test-only correction.

---

## 7. Risky improvements — documented, deliberately NOT implemented

### 7.1 Arming `generationAlreadyAttempted`

The guard is real (`decideSceneAction`) and unit-tested, but it is called with `false`. Arming it from the prior checkpoint (`FLOW_GENERATION_FAILED` / `FLOW_SCENE_NOT_COMMITTED`) would **permanently block recovery** for that scene: nothing clears the checkpoint, so every later `resume` would stop.

Safe design, when it is worth doing:

1. Persist `generation_attempts: number` and `last_generation_at` in the scene checkpoint.
2. Add `max_generation_attempts` (default **2**, matching the documented "retry failed assets" rule).
3. Arm the guard only when `attempts >= max`; expose `--reset-generation-attempts` for a deliberate retry.
4. Never arm across a checkpoint that proves commitment.
5. Tests: attempt 1 generates, attempt 2 retries, attempt 3 stops, explicit reset re-arms.

### 7.2 TITLE effective-title provenance

Including the resolved fallback title in `titleMetadata` closes the hole but changes the TITLE stage key for every existing project that recorded `titleMetadata: null`. For this project that would flip a completed stage to "stale" in every read-only report.

Safe design:

1. Introduce `resolveTitleText(explicit?)` as the single source of the fallback.
2. Have `stageArgsFor()` always pass the resolved `--title`.
3. Bump the downstream stage-key version (`stageKeyVersion: 2`) so old sidecars remain readable and are compared with their own version.
4. Add a migration that records `legacy_title_metadata_absent: true` instead of silently changing keys.

### 7.3 Thumbnail automation

A thumbnail stage needs a vision/OCR check (text legibility at 320×180, safe margins, logo placement) and a character-reference comparison. Doing that with generated text is risky (hallucinated copy). Recommended: a deterministic compositor (fixed template + approved title + character cut-out) plus a human review gate, not an LLM-generated image.

### 7.4 Removing the legacy Python entrypoints

`cli.py` / `stages.py` duplicate `one_minute.py` and have already drifted. They are not imported by the live path, but deleting them is a breaking change for any external script. Recommended: mark them deprecated in `README.md` for one release, then delete with a tag.

### 7.5 Unifying project-root resolution

Paths are derived in at least four places (`video.ts`, `pipelineGenerator.ts`, `prodCheck.ts`, `projectHealth.ts`). A single resolver is desirable but touches every stage; it needs its own change set with path-safety tests.

---

## 8. Target workflow for future videos

Every stage must be independently runnable, resumable, hash-recorded and non-destructive. "Dry-run" means *derive and report without writing or calling a paid API*.

| # | Stage | Input | Output | Retry / resume | Dry-run | Never does |
|---|---|---|---|---|---|---|
| 1 | STORY | title, concept, duration, monster | `pipeline.json` (idea/script) | provider backoff, resumable | `--check` after create | overwrite an approved project |
| 2 | SCRIPT VALIDATION | `pipeline.json` | `--check` report | pure, instant | **always** read-only | mutate the project |
| 3 | SCENE PLANNING | script | characters, backgrounds, scenes | batch resume | `--extract-only`-style preview | invent tags/outfits |
| 4 | CHARACTER REFERENCES | character locks | Flow character tiles | per-tile retry | `video status` | regenerate locked tiles |
| 5 | FLOW GENERATION | scenes + assets | committed scenes | `classifyFlowNeeds` + checkpoint | resume without `--run-flow` | generate without explicit permission |
| 6 | ASSET VALIDATION | clips/PNGs | `videoClip` verdicts + checkpoint | per-file | `production:check` | accept a corrupt clip |
| 7 | NARRATION | narration text | TTS files | per-scene resume | `narration --dry-run` (add) | silently skip a narrator scene |
| 8 | AUDIO MIX | clips + narration + bed | `final-narrated`/`final-bedded` | stage-level | `mix-validate` | clip at 0 LUFS |
| 9 | VIDEO RENDERING | mixed media + branding | `final-title.mp4` | stage key + sidecar | `production:check` | overwrite an approved render |
| 10 | MEDIA QA | final render | `video qa` report | re-runnable | **read-only** | render or mutate media |
| 11 | THUMBNAIL | title + character ref | thumbnail + review record | template-driven | composition report | publish automatically |
| 12 | SEO | story facts | package + immutable generation | `--regenerate` verifies snapshots | `--extract-only` | invent facts / reuse a hash |
| 13 | APPROVAL | artifact + hash | `approval.json` | idempotent | `publish-status` | approve without `--yes` |
| 14 | QA SUMMARY | all reports | one human summary | re-runnable | **always** | hide warnings |
| 15 | PRIVATE UPLOAD | approved artifact | private video id | explicit only | `--dry-run` (keep) | make it public |
| 16 | VERIFICATION | video id | visibility/processing report | read-only | **always** | blindly retry ambiguous outcomes |
| 17 | MANUAL PUBLICATION | human decision | public video | manual | — | ever automatic |

**Cross-stage invariants**

1. One artifact = one path + one SHA-256, recorded before the next stage starts.
2. A stage may only read upstream artifacts; it may not rewrite them.
3. Every retry is bounded and logged with a reason; ambiguous outcomes stop.
4. Approved artifacts are immutable; changes create a new generation.
5. A dry-run performs no paid call and writes nothing outside a temp dir.
6. Failures name the stage, the artifact and the exact blocker.

---

## 9. Efficiency and cost

### 9.1 Measured in this change set

| Measurement | Result |
|---|---|
| `video qa` on a 3.5-minute 720p render (4 decode passes) | **7.96 s**, read-only, hash unchanged |
| New regression suites | media QA **37** checks, CLI lock **20** checks, project check **25** checks — all pass |
| Existing targeted suites | 11 files pass; 20 files pass (66 test entries) |
| Python suites | camera 28, wardrobe 29, voice 77, SEO **459** — all pass |
| Real project audit | 23 scenes, 4 characters, 7 backgrounds, 642 words vs 750 target, no structural errors |
| Real render audit | 0 black, 0 freeze, −12.6 LUFS, −0.3 dBFS true peak, **50 clipped samples** |

### 9.2 Projected (clearly not measured)

| Opportunity | Mechanism | Projected effect |
|---|---|---|
| Duplicate Flow generation | attempt budget + armed guard (7.1) | removes whole-project regeneration after a transient failure; saves up to one generation per failed scene |
| Manual full-watch QA | `video qa` before review | ~3–5 min human time per video, and catches clipping/black/freeze before upload |
| Broken story discovered late | `--check` before any Flow run | avoids a wasted Flow pass on a structurally invalid project (zero credits spent) |
| Concurrent Flow sessions | CLI lock handshake | eliminates a class of corrupt/misattached runs (not quantifiable, but each event costs a full scene set) |
| Untracked modules | commit the live path + tests | makes the pipeline reproducible on any machine (currently not) |
| Narration wall-clock | optional API TTS behind the same duration policy | the largest remaining manual delay per video |

### 9.3 Cost-saving opportunities, ranked

1. **Commit the live modules/tests** (no runtime cost, removes the "works only on this machine" tax).
2. **Attempt budget for Flow** (direct credit saving).
3. **`--check` in the create flow** (avoids paid generation from an invalid manifest).
4. **QA probe before human review** (avoids a re-render after rejection).
5. **Parallel narration** (per-scene TTS already isolated; run 3–4 concurrently with a fixed policy).
6. **Asset cache reuse across videos** (backgrounds/character sheets are project-scoped today; cross-project reuse needs licence/provenance rules first).

---

## 10. Remaining manual tasks (in order)

1. **Confirm the finished video's YouTube visibility is Private** (local `review.status` says `posted`; publishing is blocked, but only YouTube can confirm reality).
2. **Commit the live path**: `production/src`, `production/tests`, `scripting/pipeline/{seo*,prompt_safety,voice_selector,project_check}`, schemas, prompts, docs. Exclude media, inputs, outputs, `chrome-profile*`, `.env`, `.venv*`.
3. Replace the pinned mutable-state assertions (7.1/test drift) with assertions on *derived* state, not on this project's artifacts.
4. Decide the fallback-title policy (7.2) before the next TITLE render.
5. Add the attempt-budget design (7.1) before the next long Flow run.
6. Keep using Google AI Studio narration until an API path is approved; the Run-twice rule still applies.
7. Review the thumbnail by hand until a deterministic compositor exists.
8. Approve SEO Generation 4+ only after reading the new package; never reuse a hash.

---

## 11. Next-video runbook

```powershell
# 0. one-time: keys stay in scripting/.env (never committed)
#    OPENAI_API_KEY or GROQ_API_KEY

# 1. create the story/project (5 minutes, 16:9, ~35 scenes max)
.\start-video.ps1 -Title "<your Hindi title>" -Concept "<one-line premise>"

# 2. READ-ONLY story/scene gate (zero credits, writes nothing)
cd scripting
.venv\Scripts\python.exe -m pipeline.one_minute --project-id <project-id> --check
cd ..\production

# 3. inspect state (zero credits)
npm run video -- status  --project ..\scripting\projects\<project-id>\pipeline.json
npm run video -- health  --project ..\scripting\projects\<project-id>\pipeline.json

# 4. Flow assets (only when explicitly authorised)
npm run video -- resume --project ..\scripting\projects\<project-id>\pipeline.json --run-flow --flow-session

# 5. local production to the approval gate
npm run video -- resume --project ..\scripting\projects\<project-id>\pipeline.json

# 6. READ-ONLY media QA before review
npm run video -- qa --input outputs\<project-id>\final-title.mp4 --json

# 7. SEO package, then human approval (never automatic)
npm run video -- seo --project ..\scripting\projects\<project-id>\pipeline.json
npm run video -- seo --project ..\scripting\projects\<project-id>\pipeline.json --approve-metadata --yes --by "<your name>"

# 8. approve the rendered artifact by hash
npm run video -- approve --project ..\scripting\projects\<project-id>\pipeline.json --yes

# 9. verify publish readiness (read-only, never uploads)
npm run video -- publish-status --project ..\scripting\projects\<project-id>\pipeline.json
```

Publishing remains a separate, explicit, human-confirmed step. Nothing in this runbook makes a video public.

---

## 12. Verification log

| Command | Result |
|---|---|
| `node --import tsx --test tests/media_qa_test.mts` | **37/37 pass** |
| `node --import tsx --test tests/flow_cli_lock_test.mts` | **20/20 pass** |
| `python -m pipeline.project_check_test` | **25/25 pass** |
| `python -m pipeline.one_minute --project-id <real> --check` | ok, 23 scenes, 0 errors, bytes+mtime unchanged |
| `node --import tsx --test` (11 targeted files) | all pass |
| `node --import tsx --test` (20 workflow/stage/publish files) | all pass |
| `python -m pipeline.camera_hardening_test` / `wardrobe_test` / `voice_selector_test` | 28 / 29 / 77 pass |
| `python -m pipeline.seo_test` | **459 checks, 0 failed** |
| `node node_modules/typescript/bin/tsc --noEmit` | clean |
| `python -m pipeline.prompt_hardening_test` | **fails only** on the pinned `pipeline.json` SHA (`f55742…` vs current `49215C…`) — pre-existing artifact drift, intentionally not "fixed" by touching the project |
| `node --import tsx --test tests/flow_prompt_hardening_test.mts` | **fails only** on `SA10` because the completed project now has `approval.json` — pre-existing mutable-state assertion |
| `node --import tsx --test tests/test_paths_resolution_test.mts`, `scene_executor_dispatch_test.mts` | red before this change (file-count and ownership-allowlist drift); corrected, now pass |

The full `tests/*.mts` sweep does not complete within 30 minutes on this machine (individual suites such as `title_key_provenance_test` alone take ~28 minutes because they render media). Targeted batches above cover every file touched by this change plus the workflow/stage/publish surface.

---

## 13. Bottom line

- The pipeline's **safety architecture is sound**; the largest risks are *observability, reproducibility and manual narration*.
- This change set adds a **read-only QA probe**, a **session-lock handshake**, and a **read-only story gate**, each with dedicated regression tests and no change to existing outputs.
- The most urgent non-code action is to **track the live modules and tests** so the system can run anywhere.
- The finished video is untouched: same hashes, same approval, no publishing path invoked. Its only new artefact is a QA report that says the mix has 50 clipped samples — useful for the next render, not a reason to touch this one.
