---
'@cat-factory/kernel': minor
'@cat-factory/integrations': minor
'@cat-factory/server': minor
'@cat-factory/worker': minor
'@cat-factory/node-server': minor
---

Subscription quota-cycle tracking, Part B1 (usage-and-quota-tracking): model "how much of a
subscription's quota cycle is left" for the flat-rate harnesses (Claude Code / Codex / GLM /
pooled Kimi & DeepSeek), which the spend ledger excludes.

Adds the `SubscriptionQuotaProvider` port + `SubscriptionQuotaCycleRepository` and the
`subscription_quota_cycles` table (mirrored across D1 and Drizzle/Postgres), plus
`RegistrySubscriptionQuotaProvider` — a vendor-neutral composite (mirroring
`RegistryReleaseHealthProvider`) that folds each finished subscription run's tokens into rolling
`5h` + `weekly` windows anchored at first observed use, and reports the cycle either from a real
per-vendor adapter or the MODELED fallback (persisted counters measured against per-vendor config
ceilings). The adapter registry is empty today — the real Claude/GLM reads land in Part B2 (an
executor-harness image bump), so every vendor currently reports modeled. `ContainerAgentExecutor`
records usage for BOTH pooled runs (scope = the leased pool token) and personal runs (scope = the
run initiator); it's wired into every facade, and covered by a cross-runtime conformance suite.
Modeled numbers are illustrative and NEVER billed — the metered-only spend gate is unchanged.
