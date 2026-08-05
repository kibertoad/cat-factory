# `@cat-factory/spend`: the spend safeguard

Pricing tables + spend metering/gating, plus the forward-looking forecast the proactive budget
alerts read.

**Entry:** `src/index.ts`. `SpendService.ts` (the service), `pricing.ts` (the pricing tables),
`forecast.logic.ts` (pure burn-rate / projection / alert-state logic).

**Reactive vs advisory.** `isOverBudget` and `status` are the GATE: they sum the period's metered
ledger and the engine pauses a run at the ceiling. `forecast.logic.ts` and `forecastWorkspaces` /
`forecastAccounts` are ADVISORY: they feed the `budget_threshold` alert sweep
(`@cat-factory/server`'s `runtime/spendAlerts.ts`) and, later, the Usage surface. Nothing in the
forecast may change gating, so a projection bug costs a wrong card and never a paused run. Design
record: [`spend-forecasting-and-alerts.md`](../../../docs/initiatives/spend-forecasting-and-alerts.md).

**Mutation-tested** (`stryker.config.mjs`): nightly, non-blocking, never run locally. Scope and
score floor: [`mutation-testing.md`](../../../docs/internal/mutation-testing.md).
