# Initiative: Ralph loop task type

Tracker for the "Ralph loop" task type: a persistent retry-until-done loop whose exit
condition is a harness-run programmatic validation command. Full design + rationale:
[`backend/docs/ralph-loop.md`](../../backend/docs/ralph-loop.md). Read that FIRST.

## Goal

Let a user create a task that keeps working (fresh context each iteration) until a configured
validation command passes, bounded by an iteration budget, surviving restarts. Incorporate the
community Ralph-loop learnings (programmatic exit gate, fresh context, progress log,
anti-runaway budget).

## Target pattern

- The **`ralph` agent kind** is the reusable primitive (a `container-coding` iteration body +
  `configContributions`); `pl_ralph` composes it with the ship tail; the `ralph` task type is
  discoverability sugar. The loop is driven the Tester→Fixer way (verdict on the job result →
  `RalphController` + a `ralph-verdict` `StepCompletionInterceptor`), NOT as a backend-probe
  gate, because the validation must EXECUTE in a checkout. Loop state rides `step.ralph`
  (persisted in the run `detail` blob, no migration), which is what makes it restart-safe.

## Status (v1: complete; v1.1 hardening: complete)

| Area                                                                                  | Status | Notes                         |
| ------------------------------------------------------------------------------------- | ------ | ----------------------------- |
| Contracts (`ralph.ts`, `taskType`, `step.ralph`, `AgentConfigDescriptor` text/number) | done   | rides `detail`; no migration  |
| `ralph` agent kind + prompt + config contributions                                    | done   | `agents/kinds/ralph.ts`       |
| `pl_ralph` pipeline + `defaultPipelineIdForTaskType`                                  | done   | `kernel/domain/seed.ts`       |
| Result plumbing (`ralphVerdict` on results, `jobBody` `validation`)                   | done   | `server`                      |
| Harness: run validation command + verdict + image bump                                | done   | version 1.44.0, 3 pins synced |
| Engine (`ralph.logic`, `RalphController`, interceptor, seed + start guard)            | done   | `orchestration`               |
| Frontend (task type, config inputs, `RalphLoopResultView`, i18n ×10)                  | done   | `@cat-factory/app`            |
| Cross-runtime conformance (complete / exhaust / start-guard) + logic unit tests       | done   | verified on real Postgres     |
| v1.1: re-run re-arms the loop; no-progress abort; heartbeat + shared command seam     | done   | see "v1.1" below              |

## Conventions & gotchas carried forward

- The iteration number the fake/engine keys off is `step.ralph.attempts + 1`, folded via the
  `AgentContextBuilder` per dispatch: robust to how the job is re-dispatched.
- `stopRunContainer` clears the run's jobs before re-dispatch (step.jobId already cleared →
  uses the run id), so a fresh iteration re-runs with the new context; `dispatchEpochFor` counts
  the run's prior dispatches of the kind, so each iteration gets a distinct harness job id.
- The validation command is per-task agent config (inherently repo-specific), not a merge
  preset knob, so no schema migration. The start-time guard + the SPA both require it.
- `ValidationError` surfaces as HTTP 422 (not 400): the start-guard conformance test asserts 422.

## v1.1: gaps closed after v1

- **A re-run silently un-looped the step.** `retry.logic.resetStep` rebuilds a step from a field
  list and so DROPPED `step.ralph`; unlike `step.test` (seeded lazily when the report arrives)
  the loop state is needed BEFORE the dispatch: it is what puts the `validation` block on the
  job body. A retried or restarted ralph run therefore dispatched a plain coding pass, returned
  no verdict, never fired the interceptor, and finished as an ungated one-shot coder. The
  loop-back reset (`StepGraph.resetStepForRerun`) had the mirror-image bug: it kept the state
  with `attempts` at the spent budget, so the first verdict went straight to `exhausted`. Both
  now go through the pure `restartRalphState` (frozen config kept, counters zeroed).
- **The validation command starved the inactivity watchdog.** `JOB_INACTIVITY_MS` (10 min) is
  tighter than the command's own watchdog (15 min) and a harness-spawned command emits no
  activity, so any validation past 10 minutes aborted the iteration as a wedge, and made the
  15-minute watchdog unreachable at stock settings. Now on a 30s heartbeat, like the two sibling
  harness-run phases.
- **A third copy of the captured-command seam.** `runRalphValidation` predated
  `captured-command.ts` and had drifted exactly as that seam exists to prevent: it scrubbed
  secrets AFTER the rolling truncation with no margin (a credential straddling the cut survived
  redaction as an unrecognised partial, on a tail that reaches the step, the notification and
  the SPA) and published the full 16k capture where both siblings bound the wire tail. Routed
  through `runCapturedCommand` at a 4k report budget.
- **No-progress early abort** (was a v1 follow-up). The harness stamps the work branch's HEAD on
  the verdict; two consecutive failing iterations against an unchanged head end the loop, fail
  open on an unknown head, and are reported distinctly from a spent budget everywhere.
- **The attempt log grew unbounded** inside the run `detail` blob that is re-serialized on every
  step-progress write. Capped at `MAX_RALPH_ATTEMPT_LOG` with the dropped count recorded (and
  surfaced) rather than silently truncated.

## Follow-ups (deliberately out of scope)

- **Multi-repo ralph** (fan out over involved-service repos, like `repro-test`).
- **CI-green as an alternative completion criterion** (vs the in-container command).
- **Workspace-level default validation command**.
- **Playwright e2e spec**: the loop is covered by conformance + unit tests; a live-pushed-UI
  spec is a follow-up (the `RalphLoopResultView` already carries `data-testid`s).

When these are picked up (or explicitly dropped), convert this tracker into a numbered ADR
under `backend/docs/adr/` and `git rm` this file, per CLAUDE.md.
