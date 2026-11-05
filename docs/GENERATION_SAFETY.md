# Generation safety: bounded, persistent Flow attempt budgets

Paid Flow generation (video/image credits) is the only irreversible action in this repository.
This document describes the budget, the failure rules, the manual-approval procedure and how to
inspect what happened. It matches `production/src/generationAttempts.ts` and the gates wired into
`sceneFlowWorkflow.ts`, `runner.ts`, `cli.ts` and `video.ts`.

## 1. Where the budget is recorded

One ledger per project:

```text
<OUTPUTS_ROOT>/<project-id>/flow-scenes/generation-attempts.json
```

It sits beside the per-scene checkpoints and is written atomically (temp file + rename). It contains
no cookies, tokens, signed URLs, prompts, profile paths or credentials — only attempt bookkeeping.
Because the counters are project data, **stopping and restarting a run never resets them**.

The legacy `npm run flow` CLI resolves the same file from `--output-dir`: when that directory is
named after the project it is treated as the project directory, otherwise as the outputs root.

## 2. What one attempt records

| Field | Meaning |
|---|---|
| `attempt_id`, `attempt_number` | unique attempt identity and its 1-based number for this subject |
| `project_id`, `subject_kind`, `subject_id`, `scene_number` | what was attempted |
| `started_at`, `finished_at` | when the reservation was taken and closed |
| `failure_category` | `NONE`, `RETRYABLE`, `NON_RETRYABLE`, `UNKNOWN` |
| `failure_reason` | bounded, whitespace-normalised message (never a secret) |
| `submission` | `NOT_SUBMITTED`, `SUBMITTED_CONFIRMED`, `SUBMISSION_UNKNOWN` |
| `clip_downloaded`, `validation_passed` | what actually landed on disk |
| `retry_permitted` | whether the ledger authorised an automatic retry of this failure |
| `manual_approval` | `NOT_REQUIRED`, `REQUIRED`, `APPROVED` |
| `outcome` | `IN_PROGRESS`, `SUCCEEDED`, `FAILED`, `BLOCKED` |

An `IN_PROGRESS` record with a live `active` marker means a run is (or was) in flight. It is never
silently discarded: if the process died, the next run needs approval.

## 3. Budget defaults

| Setting | Default | Env var |
|---|---|---|
| attempts per scene | 2 | `FLOW_MAX_ATTEMPTS_PER_SCENE` |
| attempts per asset (legacy characters/backgrounds) | 2 | `FLOW_MAX_ATTEMPTS_PER_ASSET` |
| attempts per project | 80 | `FLOW_MAX_ATTEMPTS_PER_PROJECT` |
| consecutive failures before a human is required | 2 | `FLOW_MAX_CONSECUTIVE_FAILURES` |
| abandoned in-progress attempt stops blocking after | 30 min | `FLOW_ATTEMPT_LOCK_STALE_MINUTES` |
| ambiguous submission always needs approval | on | `FLOW_REQUIRE_APPROVAL_AFTER_AMBIGUOUS` |

Invalid values fall back to these defaults; they are never treated as "unlimited". The ambiguity
flag is recorded for operators but cannot make an ambiguous submission retry automatically — that
rule always fails closed.

**A ceiling is a ceiling.** Manual approval grants one additional attempt *while the ceiling
stands*. To allow more total attempts you must deliberately raise the policy variable for the
project; approval alone never does.

## 4. Failure categories and retry rules

Classification uses the FlowClient **submission latch** — an observed fact, not a guess from an
error message. `FlowClient` records every paid click (`generate`, `generateBackground`,
`generateProjectVideo`, `generateProjectFirstClip`, `generateSceneVideo`) in a monotonic latch, so a
browser timeout can be distinguished from a timeout that may have submitted.

| Category | Meaning | Automatic retry |
|---|---|---|
| `RETRYABLE` | a transient error (network reset, rate limit, 5xx, navigation timeout) **and** submission is proven absent | yes, inside the remaining budget and under the consecutive-failure limit |
| `NON_RETRYABLE` | a defect that cannot succeed on retry (missing/defective prompt, missing asset metadata, authorization/target refusal) | no — needs a human and a code/config fix |
| `UNKNOWN` | anything else, including **any** failure where submission is unknown or confirmed | no — needs explicit approval |

A browser timeout with no submission proof is deliberately `UNKNOWN`. "It timed out" is not
evidence that nothing was pressed.

Pre-flight failures that provably never submitted (a lifecycle port that could not be built,
ingredient verification) **release** the reservation, so free validation failures do not consume a
credit budget.

## 5. Duplicate prevention and resume

* A valid local clip is authoritative: the generation gate is never reached.
* A committed Flow scene is downloaded, never regenerated.
* A reservation for a subject that already has a live `active` marker is refused
  (`ATTEMPT_IN_PROGRESS`), including when approval is supplied — concurrency safety beats approval.
* The gate runs immediately before the paid call, after every credit-free check.
* On resume, a scene with a valid clip or a committed Flow clip is resolved without touching the
  ledger; a scene whose budget is exhausted is blocked with `FLOW_GENERATION_BLOCKED` and the
  existing checkpoint is left intact.

Statuses you will see on a controlled stop:

| Status | Meaning |
|---|---|
| `FLOW_GENERATION_BLOCKED` (scene workflow) | the budget or approval gate refused another submission; nothing was clicked |
| `blocked` + `FLOW_GENERATION_BLOCKED`, `MANUAL_APPROVAL_REQUIRED` (legacy CLI) | same, for `npm run flow` |

## 6. Manual approval procedure

1. Inspect the history (read-only):
   ```powershell
   cd production
   npm run video -- flow-attempts --project-id <project-id>
   ```
2. Check Flow in the browser: did the last attempt actually produce a clip? If it did, download
   or import the clip instead of regenerating; the tools will adopt a valid local clip without
   spending anything.
3. If another paid attempt is genuinely justified, approve **one** attempt for **this invocation**:
   ```powershell
   npm run video -- resume --project <pipeline.json> --run-flow --flow-session `
     --approve-generation-recovery --yes
   ```
   Scope it to specific scenes when possible:
   ```powershell
   npm run video -- resume --project <pipeline.json> --run-flow --flow-session `
     --approve-generation-recovery --approve-generation-recovery-scenes 3,7 --yes
   ```
   `--yes` is required: the approval authorises a paid action.
4. If the ceiling itself is the blocker, raise `FLOW_MAX_ATTEMPTS_PER_SCENE` (or the per-asset /
   per-project value) deliberately, in that shell only, and re-run. Do not raise it by habit.

The legacy `npm run flow` CLI reads the same approvals from `FLOW_APPROVE_GENERATION_RECOVERY=1` or
`FLOW_APPROVE_GENERATION_RECOVERY_SCENES=3,7`. Prefer the one-shot flag; never commit these values
to a file.

## 7. Ambiguous outcomes

If a run stops with `SUBMISSION_UNKNOWN`, `SUBMITTED_CONFIRMED` + `FAILED`, or an `IN_PROGRESS`
attempt, the system refuses to resubmit automatically. Confirm in Flow whether a clip exists:

* **clip exists** → download it (no credits). Re-running normally adopts/downloads it.
* **no clip exists** → use the explicit recovery approval from §6 for one attempt.

Never delete the ledger to "start fresh" — that resets a real budget. If the ledger is corrupt the
next run fails closed; an approved run quarantines it as
`generation-attempts.json.corrupt-<timestamp>.json` and starts a new budget, preserving the
evidence.

## 8. Reading the ledger

Human-readable:

```text
project:  <project-id>
attempts: 6/80 project budget used
subjects: 3
  scene:3            2/2 attempts  consecutive=1  last=FAILED (UNKNOWN, SUBMISSION_UNKNOWN)  approval=REQUIRED
  scene:4            1/2 attempts  consecutive=0  last=SUCCEEDED (NONE, SUBMITTED_CONFIRMED)  approval=NOT_REQUIRED
recent attempts (newest first, ...):
  #2 scene:3 2026-11-05T... FAILED UNKNOWN/SUBMISSION_UNKNOWN downloaded=false validated=false retry=false approval=REQUIRED — Timeout 15000ms exceeded
```

`--json` prints `{ projectId, ledgerFile, exists, ledger }` for tooling. The command is read-only:
it never creates a ledger, never contacts Flow, never changes state.

## 9. Related safeguards (unchanged)

Generation still requires an explicit `--run-flow`; the single shared Flow session lock and the
per-project lock still serialise browser work; approval and publishing gates are untouched. The
attempt ledger is an additional ceiling in front of the same click, not a replacement for those
controls.
