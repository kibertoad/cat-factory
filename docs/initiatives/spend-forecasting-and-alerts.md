# Initiative: spend forecasting, burn-rate & proactive budget alerts

**Status:** planned (tracker only — no slices landed) · **Owner:** core · **Started:** 2026-07-16

> Durable source of truth for a multi-PR initiative. Read it first before picking up the
> next slice; update the checklist at the end of each PR.

## Goal & rationale

The spend safeguard (`backend/packages/spend` — `SpendService`, tiered
workspace/account/user budgets per ADR 0020) is purely **reactive**: `isOverBudget` is
checked before each agent step and, at the ceiling, the run pauses and a passive
`SpendWarningBanner` renders. There is **zero forward-looking logic** — no burn-rate, no
month-end projection, no "you'll hit the ceiling in ~3 days", and no proactive threshold
notification ("80% of budget consumed"). Getting silently paused mid-pipeline is the worst
way to learn the budget ran out; teams need the warning while there is still time to raise
the limit or stop a runaway.

Scope boundary vs the existing `usage-and-quota-tracking` initiative: that tracker owns the
**ledger and reporting** (durable usage rows incl. subscription tokens, rollups by
model/vendor/day, quota cycles). THIS initiative owns the **predictive + alerting layer on
top of the metered budget** — projection math, thresholds, notifications. It consumes that
ledger where useful but changes no gating behaviour.

End state: budget status carries burn-rate + projected month-end spend; crossing
configurable thresholds (default 80%, plus a projected-overrun signal) raises a
`budget_threshold` notification through the existing notification system (in-app + Slack +
email once wired); the Usage surface renders the projection.

## Target pattern

1. **Projection is pure logic in `packages/spend`** (`forecast.logic.ts`): inputs are
   month-to-date spend, elapsed/remaining fraction of the period, and a recent-window
   burn-rate (e.g. trailing 7 days, from ONE aggregate query — a `spendSince(scope, since)`
   port read pushed into SQL, mirrored D1 ⇄ Drizzle). Output: `{ projectedTotal,
burnRatePerDay, thresholdCrossed }`. Deterministic and unit-tested — no LLM, no new
   state machine.
2. **Evaluation points**: piggyback where spend already flows — the existing budget check
   path recomputes cheap projections per evaluation, and a periodic sweep (the retention
   sweep cadence is fine) catches quiet workspaces. No high-frequency polling.
3. **Threshold notifications, state-change semantics**: a `budget_threshold` notification
   type raised via `NotificationService` when a scope **crosses** a threshold (persist the
   last-notified threshold per scope+period so it fires once per crossing per period, and
   re-arms next period). The three budget tiers (workspace/account/user) reuse their
   existing scope identities.
4. **Surface**: extend the spend status contract with the projection fields; the Usage tab
   - `SpendWarningBanner` render burn-rate and projected overrun ("on pace to reach the
     budget on ~July 24"); thresholds configurable beside the budget limits.

## Prioritized checklist

| #   | Slice                                                                                                               | Status  | PR  |
| --- | ------------------------------------------------------------------------------------------------------------------- | ------- | --- |
| 1   | `spendSince`-style aggregate port read (D1 ⇄ Drizzle + conformance) + pure `forecast.logic.ts` with unit tests      | ⬜ todo |     |
| 2   | Projection folded into the spend status contract + Usage tab / banner rendering (i18n all locales, dates via `d()`) | ⬜ todo |     |
| 3   | `budget_threshold` notification type + once-per-crossing state + sweep for quiet scopes (both runtimes)             | ⬜ todo |     |
| 4   | Configurable thresholds beside budget limits (defaults 80%; env clamps mirror `BUDGET_MAX_MONTHLY_*`)               | ⬜ todo |     |
| 5   | Projected-overrun signal (fires when projection exceeds limit even below 80% actual)                                | ⬜ todo |     |

## Conventions & gotchas

- **Gating is untouched.** `isOverBudget` semantics do not change; forecasting is advisory.
  A projection bug must never pause or unpause a run.
- **Subscription (quota-based) usage is out of scope here** — that's
  `usage-and-quota-tracking` Part B's quota-cycle model. This initiative projects the
  _metered_ ledger only; don't blend the two meanings of "running out".
- **Once per crossing, per period**: notification state must be persisted (not in-memory)
  and reset at period rollover — the multi-replica Node deployment makes an in-process
  "already notified" flag wrong by construction.
- **Aggregates in SQL** — the burn-rate window is one `SUM ... WHERE ts >= ?` per scope,
  never a row scan in JS; if a batch multi-scope variant is needed for the sweep, add the
  batch port method.
- Early-month projections are noisy: clamp/label projections in the first days of a period
  (a 2-day sample projecting 15× is math, not information) — the logic function owns this
  rule so the UI and the notifier agree.
