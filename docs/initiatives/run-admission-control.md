# Initiative: run admission control (concurrency caps, queueing, prioritization)

**Status:** planned (tracker only — no slices landed) · **Owner:** core · **Started:** 2026-07-16

> Durable source of truth for a multi-PR initiative. Read it first before picking up the
> next slice; update the checklist at the end of each PR.

## Goal & rationale

Runs dispatch the moment they are started: `ExecutionService.start()` hands off to the
durable driver via `WorkRunner.startRun` with **no admission layer in between**. There is
no per-workspace or per-account concurrency cap, no queue, and no priority — a workspace
can stampede an unbounded number of parallel container runs (bounded only by the spend
budget and platform container limits), and background work (recurring pipelines, Kaizen,
initiative-spawned tasks) competes head-to-head with a human waiting on an interactive run.
The only prior art is initiative-local: `InitiativeService`'s per-initiative
`maxConcurrent` spawn policy throttles how many tasks ONE initiative runs at once — nothing
governs the workspace or account as a whole.

End state: an **application-level admission controller** in front of the durable driver.
Starting a run over the cap parks it in a visible `queued` state instead of dispatching;
finished runs release capacity and promote the next queued run by priority then FIFO.
Interactive (human-started) runs outrank background (recurring/initiative/Kaizen) ones.

## Target pattern

1. **Admission state on the run, not a side table**: a `queued` phase on the
   `ExecutionInstance` before the driver is started (like the spend-pause park, which is
   the reference: `isOverBudget` → pause → `signalResume`). Queued runs are ordinary
   persisted runs the sweeper/board can see — runtime-symmetric by construction.
2. **Capacity check at ONE choke point**: `ExecutionService.start()` (and `retry`) counts
   active runs (`running`/`awaiting_*` — a batch `countActiveByWorkspace` port method, one
   SQL `COUNT`, mirrored D1 ⇄ Drizzle) against the resolved cap. Over the cap ⇒ persist as
   `queued`, do NOT call `WorkRunner.startRun`. Use the check-then-act + post-action
   re-count pattern (the `MAX_ACTIVE_INITIATIVE_RUNS` lesson) so a parallel burst can't
   slip through.
3. **Release + promote**: when a run reaches terminal (the `emitInstance` terminal hook —
   the same place subscription activations are cleared), promote the highest-priority
   oldest `queued` run via the normal `startRun`. A cron/interval sweep (Worker `scheduled`
   ⇄ Node `setInterval`, per runtime symmetry) re-drives promotion if the hook is missed,
   exactly like `sweepStuckRuns`.
4. **Priority**: a small enum on the run (`interactive | background`), derived from the
   initiator (human REST/UI start vs recurring/initiative/public-API), not user-supplied.
5. **Config**: per-workspace cap in workspace settings with an account-level ceiling env
   clamp — mirroring how spend budgets layer (`BUDGET_MAX_MONTHLY_*` pattern). Unset ⇒
   unlimited (today's behaviour; strictly opt-in).
6. **Frontend**: queued runs render as a distinct badge/state on the board card +
   inspector ("Queued — N ahead"), with a cancel affordance (cancel of a queued run never
   touches the driver).

## Prioritized checklist

| # | Slice | Status | PR |
| - | ----- | ------ | -- |
| 1 | `countActiveByWorkspace` (+ list-queued-ordered) port methods, D1 ⇄ Drizzle + conformance | ⬜ todo | |
| 2 | `queued` run state + admission check in `start`/`retry` (re-count backstop) — cap unset ⇒ no behaviour change | ⬜ todo | |
| 3 | Terminal-hook promotion + sweeper backstop (both runtimes) | ⬜ todo | |
| 4 | Priority derivation (interactive vs background) + ordered promotion | ⬜ todo | |
| 5 | Workspace-settings cap + env ceiling clamp + contracts | ⬜ todo | |
| 6 | SPA queued state (board card, inspector, cancel) + i18n (all locales) | ⬜ todo | |
| 7 | Conformance: fill-cap → queue → terminal → auto-promote, asserted on both runtimes | ⬜ todo | |
| 8 | Public API: `start` over cap returns `queued` (not an error); document in the public-api tracker's surface | ⬜ todo | |

## Conventions & gotchas

- **Do not build a scheduler service.** The durable layer stays Workflows/pg-boss; admission
  is a persisted state + a promotion hook, the same shape as the spend pause. No new
  process, no in-memory queue (useless across isolates/replicas).
- **Promotion must be race-safe**: two runs finishing at once may both try to promote —
  promote-then-recount (or CAS the queued→running transition via the existing `casPersist`)
  so capacity is never exceeded; a double promotion that lands over the cap re-parks the
  younger run.
- **Interaction with the spend gate**: a queued run must re-check the budget when promoted
  (it may have been queued before the budget ran out).
- **Queued ≠ stuck**: teach the stale-run sweeper (`sweepStuckRuns`) that `queued` with no
  driver instance is healthy, or every queued run gets re-driven forever (see
  `stuck-run-audit` for the taxonomy).
- Recurring pipelines (`RecurringPipelineService.fire`) should tolerate queueing silently —
  a background run waiting is the intended behaviour, not a failure to raise.
