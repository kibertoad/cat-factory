---
"@cat-factory/contracts": minor
"@cat-factory/kernel": minor
"@cat-factory/spend": minor
"@cat-factory/orchestration": patch
"@cat-factory/worker": patch
"@cat-factory/node-server": patch
"@cat-factory/app": patch
---

Remove per-model price overrides from the workspace budget. A workspace's budget is
now just a currency + monthly limit overlaid on the built-in `DEFAULT_SPEND_PRICING`
table; the `spendModelPrices` setting, its contracts/schemas, and the
`workspace_settings.spend_model_prices` column (D1 + Postgres) are dropped. Also fixes
the budget save in the UI throwing `spendMonthlyLimit.trim is not a function` when the
number input emits a numeric value.

**Breaking:** the `spend_model_prices` column is dropped on both runtimes with no
migration of existing override data (pre-1.0); any stored overrides are discarded and
budgets fall back to the built-in price table.
