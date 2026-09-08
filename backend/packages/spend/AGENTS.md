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
missed.

A rate may sit ABOVE what the route bills (the fixed 0.92 EUR/USD factor and the
`CACHE_*_MULTIPLIER` floors are that margin, deliberately) and may never sit below it. The
yardstick is the ROUTE and not the model's vendor, because a gateway's blend is not the upstream
list price in either direction: `openrouter:qwen/qwen3.7-max` sits below Alibaba's list and above
what OpenRouter charges, and the Z.ai rows sit above the promotion the gateway serves today. Both
are the same rule.

And where a vendor bills in TWO BANDS, repricing a whole request once its input passes a threshold,
the row states BOTH: its base rates plus a `longBand`, with `bandFor` picking the band the recorded
input size lands in (three vendors do this today, OpenAI at 272K input tokens, Gemini 3.1 Pro and
Grok 4.6 at 200K). A caller that cannot see the prompt size gets the DEARER band, which is the
difference between `ratesFor`, which every meter reads, and `priceFor`, which the picker's list
price reads. The dynamic per-workspace overlay still folds a model's bands to their MAXIMUM
(`dearestRate` in `@cat-factory/integrations`' `openRouterModels.ts`), because a catalog refresh has
no prompt to measure.

`scripts/check-openrouter-pins.mjs` re-reads both against the live gateway, band for band and
threshold included (weekly, not per-PR: it makes a network call). Its coverage stops at the
`openrouter:<slug>` rows, since a direct-vendor row names no route to compare against; what keeps a
mirrored pair (`openai:X` against `openrouter:openai/X`) in step is a relation test in
`pricing.test.ts`.

**Mutation-tested** (`stryker.config.mjs`): nightly, non-blocking, never run locally. Scope and
score floor: [`mutation-testing.md`](../../../docs/internal/mutation-testing.md).
