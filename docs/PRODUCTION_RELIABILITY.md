# Production reliability (PHASE 5)

This document describes the long-form production reliability layer: stage state, checkpoint
semantics, resume/recovery rules, idempotency, resource preflight, observability and the approval
boundary.

It is a **derived, read-only** layer. It does not replace any existing state store:

| Authority | File | Owns |
| --- | --- | --- |
| Story/scene manifest | `scripting/projects/<id>/pipeline.json` | story, scenes, prompts, narration text |
| Persisted project checkpoint | `production/outputs/<id>/state.json` | project lifecycle state, failures |
| Paid submission ledger | `production/outputs/<id>/flow-scenes/generation-attempts.json` | Flow attempt budget, submission state, manual-approval gate |
| Scene outputs | `production/outputs/<id>/scene-####.mp4` + `.json` sidecars | rendered scene media + render key |
| Downstream stages | `final-with-fades.mp4` / `final-narrated.mp4` / `final-bedded.mp4` / `final-title.mp4` + `.stage` sidecars | EDIT/MIX/BED/TITLE outputs + dependency keys |
| Human approval | `production/outputs/<id>/approval.json` | the approval decision, artifact hash, QA evidence |

Everything in this document is computed from those files. Nothing here invents a second state
machine, and nothing here writes media, approves, uploads or publishes.

## Stage state model

`production/src/reliability.ts`

The production chain and its review gates, in dependency order:

```
STORY → STORY_VALIDATION → SCENE_PLANNING → NARRATION → GENERATION →
SCENE_ASSEMBLY → AUDIO_MIX → MUSIC_BED → FINAL_RENDER →
MEDIA_QA → HUMAN_REVIEW → APPROVAL → PUBLISH_HANDOFF
```

`SCENE_ASSEMBLY`, `AUDIO_MIX`, `MUSIC_BED` and `FINAL_RENDER` map 1:1 onto the existing
`EDIT`, `MIX`, `BED` and `TITLE` downstream stages. No new media stage exists.

Each stage carries exactly one state:

| State | Meaning |
| --- | --- |
| `pending` | no verified output exists yet; the stage may run when its inputs are ready |
| `running` | an attempt started and has not recorded completion (e.g. an interrupted run) |
| `completed` | a verified output exists and its dependency key still matches |
| `failed` | an attempt was made and failed (the failure is recorded, never hidden) |
| `blocked` | a required external input or human decision is missing |
| `skipped` | the stage did not apply to this run (never treated as `completed`) |
| `stale` | a dependency changed or the recorded output can no longer be verified |

### Legal transitions

`LEGAL_STAGE_TRANSITIONS` in `reliability.ts` validates every transition and
`assertLegalStageTransition` throws on an illegal one. The important invariants:

- `completed` can only be left by invalidation (`stale`/`pending`), never by an ad-hoc edit.
- `failed` never silently becomes `completed`; it must go through `pending`/`running` again.
- `blocked` is non-terminal: it waits for a human input or approval.
- `skipped` is not `completed`.

The CLI never mutates these states; they are derived from evidence on every read.

## Checkpoint semantics

A stage is complete only when **all** of the following hold:

1. its output artifact exists;
2. the artifact passes verification (`validateVideoClip` `VALID` for media);
3. its sidecar records the dependency key computed from the current inputs;
4. the recorded output hash still matches the file on disk.

Consequences:

- `state.json` alone is never proof of completion.
- A missing sidecar produces `STALE_UNKNOWN`, not `CURRENT`.
- A corrupt sidecar contributes no key, which fails closed.
- Scene completion additionally requires the scene render key to match the current scene
  definition, assets and narration hash (`sceneState.ts`).

### Scene downloads

`processSingleFlowScene` validates the downloaded clip **before** writing a success checkpoint.
A transport-level download success whose file is not `VALID` records `DOWNLOAD_FAILED` and returns
`DOWNLOAD_FAILED`; it never records `DOWNLOAD_SUCCESS`. The partial file is left on disk for
inspection (never auto-deleted) and the next run retries the download of the already-committed
Flow scene. Ambiguous paid submissions remain governed by the Phase 2 ledger and are never
automatically resubmitted.

## Resume and recovery

`deriveReliability()` produces:

- `resume_from` — the earliest production stage that is not safely `completed`/`skipped`;
- `work_set` — the stages this pass would actually (re)run;
- `reusable` — completed stages whose verified outputs are reused as-is;
- `next_gate` — the first unsatisfied QA/human gate;
- `blockers` — the failed/blocked stages with their failure category.

Recovery rules:

- Resume from the earliest genuinely incomplete or invalid stage.
- Reuse every verified output whose dependency key still matches.
- Never treat an invalid or unverifiable output as complete.
- Changed inputs invalidate the changed stage and everything downstream of it; unrelated stages
  stay reusable.
- Never automatically retry an ambiguous paid Flow submission.
- Never auto-delete partial files.
- `publishable` is always `false` in the reliability report. Publishing is never a recovery step.

## Idempotency

- Input fingerprints are stable: sorted scene definitions, render keys, output hashes, stage keys.
- An unchanged project re-runs to a true no-op: no re-render, no re-download, no new checkpoint.
- A changed input re-runs only its dependent stages.
- No generative step is claimed to be deterministic; the model output can differ, but the
  *decision* to re-run is deterministic.
- Checkpoints are written atomically, and a stage success is only recorded after verification.

## Resource preflight

`production/src/resourcePreflight.ts`, opt-in via `npm run video -- resume --preflight`.

Checks, in order:

1. `ffmpeg` and `ffprobe` are executable (version probe, not path trust);
2. the project outputs directory exists/writable (a short-lived probe file is created and removed;
   no existing file is ever touched);
3. free disk space against a conservative estimate (scene clips + downstream renders + audio
   overhead + headroom).

Unknown free-space capacity is a `WARNING`, not a failure. A real blocker (missing dependency,
unusable output directory, provably insufficient disk) returns `RECOVERABLE_FAILURE` **before** the
project lock is taken and before any render starts, with a blocker naming the failure category.

`status` and every `dryRun` inspection never run preflight and never create the outputs directory.

## Observability

- `run.log.jsonl` records one bounded JSON line per run (status, blocker count, executed stages,
  lock state, preflight status). It is best-effort and never breaks a run.
- `buildStageLogEntry()` builds a bounded, secret-free per-stage record:
  project id, stage, status, start/end/duration, input/output fingerprints, retry count,
  error category, recovery decision, reuse/rerender reason.
- `safeLogText()` redacts credential patterns (shared `SECRET_REDACTION_RE` with `state.json`),
  signed-URL markers, `blob:` URLs and absolute machine paths.
- `containsSecretMaterial()` is the test/guard helper used by the offline suite.

## Failure categories

| Category | Raised by |
| --- | --- |
| `DEPENDENCY_MISSING` | preflight: ffmpeg/ffprobe not executable |
| `OUTPUT_DIR_INVALID` | preflight: outputs dir missing/unwritable |
| `INSUFFICIENT_DISK` / `DISK_UNKNOWN` | preflight: free-space estimate |
| `OUTPUT_STALE` | reliability: dependency changed or output unverifiable |
| `INPUTS_BLOCKED` | reliability: missing narration/input or blocked gate |
| `INVALID_PIPELINE` | reliability: pipeline missing/malformed |
| `SCENE_FAILED` | reliability: scene production failed |
| `STAGE_FAILED` | reliability: EDIT/MIX/BED/TITLE technically failed |
| `QA_FAILED` | reliability / contract: Phase 4 media QA recorded blockers |

Every category is reported on the stage that produced it, never as a generic "run failed".

## Output contract

`production/src/outputContract.ts`, `npm run video -- contract --project ...`.

One report maps the Phase 4 QA report and the approval verdict onto the long-form contract clauses:

`duration`, `streams`, `resolution_aspect`, `fps`, `av_sync`, `scene_order`, `narration_coverage`,
`branding_title`, `qa_evidence`, `approval`.

Rules:

- A clause with no QA evidence is `SKIPPED`, never `PASS`.
- The QA evidence must be bound to the exact artifact hash.
- The approval must be `APPROVED` and its hash must equal the QA artifact hash.
- `publishable` is `true` only when QA is not `FAIL`, the artifact is hash-bound approved, and no
  clause failed. Even then, `publish_boundary` is `READY_FOR_EXTERNAL_PUBLISHER` — a human still
  has to confirm the external publish explicitly.
- Rendering success alone never makes a video publishable.

## Approval boundary

Unchanged from Phase 4 and enforced here:

- No auto-approval. Human approval is an explicit, separate action (`npm run video -- approve`).
- Approval is bound to one exact artifact hash and the TITLE stage key.
- Changed media invalidates the approval (`STALE_APPROVAL`).
- QA blockers refuse approval; warnings are visible and block only with `--qa-warnings-block`.
- Publishing is never triggered by this layer. `publish-status` stays read-only.

## Known limitations

- `sceneFlowWorkflow` still carries a dead `generationAlreadyAttempted: false` guard. The Phase 2
  ledger remains the authoritative attempt budget, so this does not permit extra submissions; it
  is documented here rather than changed to avoid altering proven Phase 2 behaviour.
- Branding/title overlay is verified by the TITLE stage sidecar and canonical artifact name, not by
  pixel recognition.
- Scene-transition continuity, caption timing and stem-separated music mixing remain the
  documented Phase 4 QA gaps; they are reported as `SKIPPED`, never as clean.
- The disk estimate is deliberately conservative and may over-estimate; it is a safety floor, not
  a precise prediction.
- Preflight runs only on the execution path; it is not a substitute for real stage failure
  diagnostics.
