# Initiative: Ralph loop task type

Tracker for the "Ralph loop" task type — a persistent retry-until-done loop whose exit
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
  (persisted in the run `detail` blob — no migration), which is what makes it restart-safe.

## Status (v1 — complete)

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

## Conventions & gotchas carried forward

- The iteration number the fake/engine keys off is `step.ralph.attempts + 1`, folded via the
  `AgentContextBuilder` per dispatch — robust to how the job is re-dispatched.
- `stopRunContainer` clears the run's jobs before re-dispatch (step.jobId already cleared →
  uses the run id), so a fresh iteration re-runs with the new context; `dispatchEpochFor` adds
  `step.ralph.attempts` so each iteration gets a distinct harness job id.
- The validation command is per-task agent config (inherently repo-specific), not a merge
  preset knob — so no schema migration. The start-time guard + the SPA both require it.
- `ValidationError` surfaces as HTTP 422 (not 400) — the start-guard conformance test asserts 422.

## Follow-ups (deliberately out of v1)

- **Multi-repo ralph** (fan out over involved-service repos, like `repro-test`).
- **CI-green as an alternative completion criterion** (vs the in-container command).
- **No-progress early abort** (stop when the head SHA hasn't moved + validation still fails,
  like the conflicts gate's cap) instead of relying only on the iteration budget.
- **Workspace-level default validation command**.
- **Playwright e2e spec** — the loop is covered by conformance + unit tests; a live-pushed-UI
  spec is a follow-up (the `RalphLoopResultView` already carries `data-testid`s).

When these are picked up (or explicitly dropped), convert this tracker into a numbered ADR
under `backend/docs/adr/` and `git rm` this file, per CLAUDE.md.
