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

**Two invariants bind every row you add to `pricing.ts`**, and the second is the one that gets
missed. A rate may sit ABOVE the vendor's list (the fixed 0.92 EUR/USD factor and the
`CACHE_*_MULTIPLIER` floors are that margin, deliberately) and may never sit below it. And where a
vendor bills in TWO BANDS, repricing a whole request once its prompt passes a threshold, the row
carries the LONG band: this table has one slot per model and cannot read the prompt actually sent.
Three vendors do that today (OpenAI at 272K input tokens, Gemini 3.1 Pro and Grok 4.6 at 200K), and
the same max-fold is what the dynamic per-workspace overlay applies via `dearestRate`
(`@cat-factory/integrations`' `openRouterModels.ts`), so a static row on the short band contradicts
the path it sits behind. `scripts/check-openrouter-pins.mjs` re-reads both against the live gateway
(weekly, not per-PR: it makes a network call).

**Mutation-tested** (`stryker.config.mjs`): nightly, non-blocking, never run locally. Scope and
score floor: [`mutation-testing.md`](../../../docs/internal/mutation-testing.md).
