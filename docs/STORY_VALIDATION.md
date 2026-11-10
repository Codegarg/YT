# Story & scene validation (PHASE 3)

PHASE 3 is the **story and scene intelligence** milestone. It answers one question before any
paid production work:

> Can this story, with these characters, backgrounds and scenes, actually be produced — and is it
> good enough that a human should spend credits on it?

It is **read-only**. It never writes the project, never calls a model or the network, never opens
a browser, never spends a Flow credit, and never publishes.

## One validator, two front ends

There is exactly **one** authoritative rule set:

```text
scripting/pipeline/project_check.py      ← the rules (canonical)
        ▲
        │  python -m pipeline.one_minute --check --project-file <pipeline.json>
        │
        ├── production/src/storyValidation.ts   (typed bridge: parse → normalise → gate → render)
        │       └── gate points in the workflow / Flow runner / scene executor / legacy CLI
        │
        └── npm run video -- validate ...       (human + machine-readable report)
```

The Python module reuses the canonical helpers from `one_minute.py`
(`validate()`, `_is_strict_project()`, `_is_strict_character()`, `_resolve_outfit()`,
`_appearance_text()`, `derive_camera_safety()`) instead of duplicating them. The TypeScript side
does **not** re-implement any rule: it shells out to the same CLI and only parses the JSON.

## Commands

```powershell
cd production

# Human-readable audit (blocks nothing; exit 0 = no blockers)
npm run video -- validate --project ..\scripting\projects\my-project\pipeline.json

# Machine-readable JSON (same document as the Python CLI)
npm run video -- validate --project ..\scripting\projects\my-project\pipeline.json --json

# Project id instead of a path
npm run video -- validate --project-id my-project --json

# Treat WARNINGs as review failures too (exit 1)
npm run video -- validate --project ..\scripting\projects\my-project\pipeline.json --strict
```

The Python CLI is unchanged for existing callers and gains two optional flags:

```powershell
.venv\Scripts\python.exe -m pipeline.one_minute --project-id my-project --check
.venv\Scripts\python.exe -m pipeline.one_minute --check --project-file ..\any\pipeline.json --strict
```

Exit codes: `0` no blockers (warnings may exist), `1` blocked (or warnings with `--strict`),
`2` usage error.

## BLOCKER vs WARNING vs INFO

| Severity | Meaning | Blocks paid generation? |
| --- | --- | --- |
| `BLOCKER` | The project cannot be produced correctly: broken schema, contradictory scene references, missing narration, unresolved wardrobe, missing voice contract. | **Always.** |
| `WARNING` | A quality problem a human should review: weak hook, repeated line, thin camera/sound, pacing drift, ambiguous multi-character camera language. | Only with `--story-warnings-block` (explicit strict review). |
| `INFO` | Useful context (legacy appearance contract, missing optional `effects`, thin sound design). | Never. |

Because the generator is deterministic and the final call is always human, warnings are surfaced,
not silently enforced. Blockers are different: they describe a project that cannot be rendered
into a correct video, so no credits are spent on it.

## Exact rules

Thresholds are grounded in the real committed project and the literal prompt templates, not
invented numbers.

### Blockers

| Code | Rule |
| --- | --- |
| `PROJECT_ID_MISSING` | `pipeline.project_id` must be a non-empty string. |
| `CHARACTERS_INVALID` / `BACKGROUNDS_INVALID` / `SCENES_INVALID` | Those top-level fields must be JSON arrays. |
| `STRUCTURE_INVALID` | Whatever the canonical `validate()` rejects (tags, sequence, speaker, wardrobe contract). |
| `SCENE_COUNT_OUT_OF_RANGE` | Outside `MIN_SCENES`..`MAX_SCENES` (2..35). |
| `NARRATION_MISSING` | Every `NARRATOR`/`none` scene needs `narration_text`; the report lists the scene ids. |
| `INVALID_SCENE` | A `scenes[]` entry is not an object. |
| `INVALID_SCENE_ID` | `scene_number` is not a positive integer. |
| `DUPLICATE_SCENE_ID` | Two scenes share a `scene_number`. |
| `SCENE_ORDER_INVALID` | `scene_number` is not sequential from 1 in story order. |
| `BACKGROUND_TAG_MISSING` | A scene has no `background_tag`. |
| `UNKNOWN_BACKGROUND_REFERENCE` | A scene references a tag that is not defined in `backgrounds[]`. |
| `CHARACTER_TAGS_INVALID` | `character_tags` is not an array. |
| `UNDEFINED_CHARACTER_REFERENCE` | A scene references a character tag that is not defined. |
| `SPEAKER_MISSING` / `INVALID_SPEAKER` | `speaker` must be `NARRATOR`, `none`, or a defined character tag. |
| `SPEAKER_NOT_IN_SCENE` | The speaking character is not in the scene's `character_tags`. |
| `DIALOGUE_MISSING` | A character-speaking scene has no `devanagari_dialogue`. |
| `VISUAL_ACTION_MISSING` | A scene has no `visual_action`. |
| `CHARACTER_VOICE_MISSING` | A character has no `voice_description` (the Flow voice contract is incomplete). |
| `WARDROBE_UNRESOLVED` | A strict project's scene outfit selection cannot be resolved without inventing a garment. |
| `APPEARANCE_LOCK_MISSING` | A strict character has no usable `appearance_lock`. |
| `PROJECT_NOT_FOUND` / `PROJECT_UNREADABLE` | The file is missing, not valid JSON, or not a JSON object. |

### Warnings

| Code | Rule |
| --- | --- |
| `WEAK_VISUAL_ACTION` | `visual_action` shorter than 40 characters. |
| `CAMERA_MISSING` / `CAMERA_UNDERSPECIFIED` | No camera, or shorter than 20 characters. |
| `SOUND_DESIGN_MISSING` | No `sound_design` (the clip would have no ambience/SFX). |
| `ANIMATION_PROMPT_MISSING` | The prompt for the scene's speaking mode is absent (production would fail before submission). |
| `CAMERA_UNSAFE_FOR_MULTI_CHARACTER` | 2+ characters with over-the-shoulder / reverse / behind-character language; the prompt renderer normalises it, but the intent is ambiguous. |
| `UNUSED_NARRATION` | A character-speaking scene also carries `narration_text` (the native Flow voice wins). |
| `ORPHAN_DIALOGUE` | A `NARRATOR`/`none` scene carries a dialogue line that is never spoken. |
| `DUPLICATE_SCENE_CHARACTER` | A scene repeats a tag in `character_tags`. |
| `REPEATED_LINE` | The same spoken/narrated line (≥ 12 characters) appears in more than one scene. |
| `REPETITIVE_SCENE` | The same visual action (≥ 12 characters) appears in more than one scene. |
| `WEAK_OPENING` | Scene 1 has fewer than 40 characters of spoken/narrated text. |
| `ENDING_UNCLEAR` / `ABRUPT_ENDING` | The last scene has no spoken/narrated text, or fewer than 40 characters. |
| `WORD_COUNT_OFF_TARGET` | The script is outside 60%–140% of `script.word_count` (default `duration × 150`). |
| `SCENE_PACING_OFF_TARGET` | Scene count is outside 0.5×–1.5× `duration_minutes × 7`. |
| `NO_CHARACTER_DIALOGUE` | The story has no character-spoken beat at all. |
| `SUSPENSE_PROGRESSION_WEAK` | No character-spoken beat in the final 40% of scenes. |
| `CHARACTER_ATTRIBUTE_UNSPECIFIED` | A character's age/gender/profession is explicitly unspecified. |
| `CHARACTER_PROMPT_MISSING` / `CHARACTER_LOOK_MISSING` | No `full_prompt`, or no `look_summary`/`appearance_lock`. |
| `DUPLICATE_CHARACTER_NAME` | Several tags share one display name. |
| `BACKGROUND_LOCATION_MISSING` / `BACKGROUND_PROMPT_MISSING` | Missing background metadata. |
| `UNUSED_BACKGROUND` / `UNUSED_CHARACTER` | Generated assets that no scene uses. |
| `SCRIPT_METADATA_MISSING` / `WORD_TARGET_INVALID` / `DURATION_INVALID` | Story length/pacing cannot be verified. |

### INFO

`LEGACY_APPEARANCE_CONTRACT` (legacy `look_summary` fallback; strict wardrobe checks are skipped),
`EFFECTS_MISSING`, `SOUND_DESIGN_THIN` (< 8 characters).

## JSON contract

The report is additive over the historical shape, so older consumers keep working:

```json
{
  "ok": true,
  "status": "REVIEW",
  "read_only": true,
  "project_id": "my-project",
  "scenes": 23,
  "characters": 4,
  "backgrounds": 7,
  "counts": { "blockers": 0, "warnings": 6, "infos": 1 },
  "stats": { "words": 642, "word_target": 750, "dialogue_scenes": 8, "narration_scenes": 16 },
  "findings": [ { "code": "...", "message": "...", "severity": "WARNING", "scope": "scene", "scene": 4 } ],
  "story_findings": [],
  "scene_findings": [ { "scene": 4, "findings": [] } ],
  "errors": [],
  "warnings": [],
  "info": [],
  "recommended_actions": ["..."],
  "project_file": "..."
}
```

`errors` / `warnings` are the historical fields and contain exactly the `BLOCKER` / `WARNING`
findings. `status` is `PASS` (nothing to report), `REVIEW` (warnings only) or `BLOCKED` (blockers).
`ok` remains `blockers == 0`.

## Where the gate runs

The same pure decision (`decideStoryGate`) is enforced at every entry point that can spend credits:

1. `resumeProjectWorkflow` (and `createProjectWorkflow`) — **before** any Flow strategy or stage
   execution. A blocked paid run returns `STORY_BLOCKED` / `STORY_REVIEW_REQUIRED` /
   `STORY_VALIDATION_UNAVAILABLE` and leaves every file untouched. Zero-credit resume is not
   stopped, but the report is attached to the result and printed by `renderWorkflowReport`.
2. `createRealFlowRunner` — **before** `withFlowSessionLock` and before the `npm run flow`
   subprocess exists, so a blocked story never reaches a browser or a paid submission.
3. `createRealSceneExecutor` — per-scene defence from the forwarded report; only findings that
   name the scene are considered, so an unrelated project-level finding cannot stop a valid local
   render.
4. The legacy `npm run flow` CLI (`src/cli.ts`) — **before** `start()` opens Chrome. It gates on
   blockers (and on warnings when `FLOW_STORY_WARNINGS_BLOCK=1`).

Injection is explicit (`storyValidator` option). Tests and callers that do not pass it behave
exactly as before; the production entrypoints (`video.ts`, `cli.ts`) always wire it.

### Availability policy

A paid run fails **closed** if the validator cannot run (missing Python, crash, unparsable
output): no report means no proof the story is sound. Zero-credit paths pass `allowUnavailable`
and tolerate it, because they cannot spend anything.

## Relationship to PHASE 2 (generation safety)

Phase 2 owns attempt budgets, the durable ledger, the submission latch, the Flow session lock and
the recovery/approval gates. Phase 3 sits **before** all of it:

- it never reserves, releases or resets an attempt;
- it never edits `generation-attempts.json`, checkpoints, `state.json`, approvals or reviews;
- it runs before the lock, so it cannot deadlock or serialise Flow work;
- a block is a refusal to *start*, not a failed attempt — the ledger is untouched;
- DOWNLOAD-first behaviour, `done` skips and resume semantics are unchanged.

## Resolving findings

- **Blockers** must be fixed at the story source. For a generated project, regenerate the story
  (`start-video.ps1` / `npm run video -- create`) or repair `pipeline.json` deliberately; a
  blocked project keeps all its files for inspection.
- **Warnings** are a human judgement call. Review them, fix the ones that matter, and proceed.
  Use `--story-warnings-block` only when you want a hard gate for a specific review.
- Re-run `npm run video -- validate` after any edit; the report is deterministic (no timestamps),
  so two runs over the same file are byte-identical.

## Tests

- `scripting/pipeline/project_check_test.py` — rule-level fixtures (classification, invariants,
  read-only guarantee, deterministic output).
- `production/tests/story_validation_test.mts` — parser/normaliser/gate/bridge plus one end-to-end
  run against the real canonical Python validator (temp project, hash-verified read-only).
- `production/tests/story_gate_test.mts` — every gate point with injected fakes: blockers stop
  paid work, warnings do not, strict review does, unavailable fails closed, and the real committed
  project is byte-identical afterwards.

All of them are offline: no network, no model, no Chrome/Flow, no credits, no publishing.
