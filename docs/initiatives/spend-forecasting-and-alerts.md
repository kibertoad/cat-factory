# Initiative: spend forecasting, burn-rate & proactive budget alerts

**Status:** in progress (slices 1, 3 and 5 landed) · **Owner:** core · **Started:** 2026-07-16

> Durable source of truth for a multi-PR initiative. Read it first before picking up the
> next slice; update the checklist at the end of each PR.

## Goal & rationale

The spend safeguard (`backend/packages/spend`: `SpendService`, tiered
workspace/account/user budgets per ADR 0020) is purely **reactive**: `isOverBudget` is
checked before each agent step and, at the ceiling, the run pauses and a passive
`SpendWarningBanner` renders. There is **zero forward-looking logic**: no burn-rate, no
month-end projection, no "you'll hit the ceiling in ~3 days", and no proactive threshold
notification ("80% of budget consumed"). Getting silently paused mid-pipeline is the worst
way to learn the budget ran out; teams need the warning while there is still time to raise
the limit or stop a runaway.

Scope boundary vs the existing `usage-and-quota-tracking` initiative: that tracker owns the
**ledger and reporting** (durable usage rows incl. subscription tokens, rollups by
model/vendor/day, quota cycles). THIS initiative owns the **predictive + alerting layer on
top of the metered budget**: projection math, thresholds, notifications. It consumes that
ledger where useful but changes no gating behaviour.

End state: budget status carries burn-rate + projected month-end spend; crossing
configurable thresholds (default 80%, plus a projected-overrun signal) raises a
`budget_threshold` notification through the existing notification system (in-app + Slack +
email once wired); the Usage surface renders the projection.

## Target pattern

1. **Projection is pure logic in `packages/spend`** (`forecast.logic.ts`): inputs are
   month-to-date spend, elapsed/remaining fraction of the period, and a recent-window
   burn-rate (e.g. trailing 7 days, from ONE aggregate query: a `spendSince(scope, since)`
   port read pushed into SQL, mirrored D1 ⇄ Drizzle). Output: `{ projectedTotal,
burnRatePerDay, thresholdCrossed }`. Deterministic and unit-tested: no LLM, no new
   state machine.
2. **Evaluation points**: piggyback where spend already flows. The existing budget check
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
| 1   | `spendSince`-style aggregate port read (D1 ⇄ Drizzle + conformance) + pure `forecast.logic.ts` with unit tests      | ✅ done |     |
| 2   | Projection folded into the spend status contract + Usage tab / banner rendering (i18n all locales, dates via `d()`) | ⬜ todo |     |
| 3   | `budget_threshold` notification type + once-per-crossing state + sweep for quiet scopes (both runtimes)             | ✅ done |     |
| 4   | Configurable thresholds beside budget limits (defaults 80%; env clamps mirror `BUDGET_MAX_MONTHLY_*`)               | ⬜ todo |     |
| 5   | Projected-overrun signal (fires when projection exceeds limit even below 80% actual)                                | ✅ done |     |
| 6   | Warn a USER before their own budget runs out (needs a per-user surface; see the gotcha below)                       | ⬜ todo |     |

## Conventions & gotchas

- **Gating is untouched.** `isOverBudget` semantics do not change; forecasting is advisory.
  A projection bug must never pause or unpause a run.
- **Subscription (quota-based) usage is out of scope here**: that's
  `usage-and-quota-tracking` Part B's quota-cycle model. This initiative projects the
  _metered_ ledger only; don't blend the two meanings of "running out".
- **Once per crossing, per period**: notification state must be persisted (not in-memory)
  and reset at period rollover; the multi-replica Node deployment makes an in-process
  "already notified" flag wrong by construction.
- **Aggregates in SQL**: the burn-rate window is one `SUM ... WHERE ts >= ?` per scope,
  never a row scan in JS; if a batch multi-scope variant is needed for the sweep, add the
  batch port method.
- Early-month projections are noisy: clamp/label projections in the first days of a period
  (a 2-day sample projecting 15× is math, not information); the logic function owns this
  rule so the UI and the notifier agree.

## Carried out of slices 1, 3 and 5

- **No `spendSince` port method was needed after all, but a `firstSeenAt` was.** The trailing
  window is just `totalsSince*` with an earlier `since`, so the planned aggregate read collapsed
  into two BATCHED ones (`meteredSpendByWorkspaceSince` / `meteredSpendByAccountSince`) whose
  reason to exist is the SWEEP, not the window: it asks about every tenant on every pass, and a
  point read per scope is the banned N+1. What the plan did miss is the denominator. Dividing a
  window's cost by the NOMINAL window understates a scope younger than it by up to two orders of
  magnitude, so a workspace that started burning money two hours ago reports as calm: precisely
  the case the whole initiative exists for. `MIN(created_at)` rides out beside the sum in the same
  GROUP BY and the rate divides by the span actually observed.
- **The noise rule cuts BOTH ways, so it is expressed as observed span, not elapsed period.**
  The tracker framed early-period noise as over-projection (a 2-day sample projecting 15x). The
  trailing window removes that one, and replaces it with the opposite: too little history now
  UNDER-states. One rule covers both: below `MIN_OBSERVED_SPAN_MS` the confidence is
  `insufficient-history` and the projection is withheld rather than published. The measured rate
  is still reported, because it is the projection that is unpublishable, not the measurement.
- **The card row IS the notified-state store; no new table.** The requirement was "persisted, not
  in-memory, re-armed per period", which the notification row already satisfies across replicas
  and restarts. What it needed was a read that IGNORES card status
  (`NotificationRepository.listLatestByType`): a threshold, once crossed, stays crossed all month,
  so an open-only read would raise a fresh card every pass the moment a human dismissed theirs.
  The period is stamped in the payload, which is what re-arms every signal at the rollover.
- **A card's copy is part of its dedup identity, so it may not name a moving number.**
  `NotificationService.raise` re-delivers when title, body or payload change, so "on pace to reach
  143 EUR by 24 July" would re-toast the inbox every fifteen minutes for the rest of the month.
  The card names the threshold and the limit (both stable); the burn rate and the projection
  belong on the Usage surface slice 2 builds. `spend-alert.logic.test.ts` pins the stability.
- **The USER tier is out of scope by DESIGN, not omission.** The alert card is workspace-visible
  and there is no per-user inbox, so alerting on a personal budget would publish one person's
  spend to their whole board. `budgetAlertTierSchema` is `workspace | account` and says why;
  slice 6 owns the surface that would make the third tier possible.
- **No opt-in flag, unlike the platform-health sweep.** Having configured a budget IS the opt-in,
  and a warning that only fires when an operator remembered to switch warnings on is the silent
  pause this initiative exists to replace. The sweep no-ops when notifications are unwired.
