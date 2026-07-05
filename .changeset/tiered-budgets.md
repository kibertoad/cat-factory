---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/spend': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': minor
'@cat-factory/workspaces': minor
'@cat-factory/worker': minor
'@cat-factory/node-server': minor
'@cat-factory/local-server': minor
'@cat-factory/app': minor
---

Tiered spend budgets (account / workspace / user) with operator hard caps.

Budgets are now tracked and enforced across three tiers: the existing per-workspace
monthly limit, a per-account limit, and a per-user limit. A run pauses when any applicable
tier is exhausted. All three tiers are configurable and visible in the Budget settings
screen.

Two new environment variables (`BUDGET_MAX_MONTHLY_PER_ACCOUNT`,
`BUDGET_MAX_MONTHLY_PER_USER`), read by the Node and Cloudflare config loaders, set
operator hard ceilings on the account/user tiers; the UI cannot exceed a configured cap and
shows it on the budget screen. See `docs/environment-variables.md` and
`docs/initiatives/tiered-budgets.md`.

Breaking (pre-1.0, no data migration): the `token_usage` ledger gains nullable
`account_id`/`user_id` columns (existing rows are unattributed and excluded from the new
account/user rollups until re-metered); `TokenUsageRecord`, `RecordUsageInput`, and
`SpendPricing` gained fields; `SpendService.isOverBudget` now takes an optional tier scope.
A new `user_settings` table and `GET/PUT /user-settings` endpoint carry the user-tier
budget.
