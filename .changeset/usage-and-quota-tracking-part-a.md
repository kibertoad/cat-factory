---
'@cat-factory/kernel': minor
'@cat-factory/contracts': minor
'@cat-factory/spend': minor
'@cat-factory/server': minor
'@cat-factory/worker': minor
'@cat-factory/node-server': minor
'@cat-factory/app': minor
'@cat-factory/orchestration': patch
'@cat-factory/local-server': patch
'@cat-factory/executor-harness': patch
---

Token-usage tracking for BOTH metered API traffic and flat-rate subscription harnesses
(usage-and-quota-tracking initiative, Part A). The `token_usage` spend ledger gains a
`billing` discriminator (`metered` | `subscription`) + `vendor` column, and subscription
harness usage (Claude Code / Codex / GLM / pooled Kimi & DeepSeek) — previously kept out of
the ledger entirely — is now recorded durably for reporting. The budget gate is unchanged:
every spend rollup (`status` / `isOverBudget` / the account & user tiers) filters
`billing = 'metered'`, so a flat-rate quota call is counted for the usage report but never
inflates spend or trips a budget.

New `GET /workspaces/:ws/usage` returns the current period's usage broken down by
`(billing, vendor, provider, model)`, surfaced in a new "Usage" tab in Workspace Settings
(both metered and subscription usage, with per-model progress bars). Subscription cost is
illustrative (the equivalent metered-API cost), never billed.

D1 migration `0044_usage_billing.sql` ⇄ the Drizzle schema + generated migration; the
cross-runtime conformance suite pins the metered-vs-subscription split on both stores. No
data migration — existing rows default to `metered`.

(The `@cat-factory/executor-harness` bump is a test-only type fix — its fake
`TokenUsageRepository` gains the new `usageBreakdownForWorkspace` method; nothing in the
runner image changed.)
