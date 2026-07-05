---
"@cat-factory/contracts": minor
"@cat-factory/kernel": minor
"@cat-factory/caching": minor
"@cat-factory/server": minor
"@cat-factory/orchestration": minor
"@cat-factory/worker": minor
"@cat-factory/node-server": minor
"@cat-factory/local-server": minor
---

Add an account-wide model-family allow/block policy. An account admin can constrain which
LLM families their teams run (block/allow lists over families like DeepSeek, Qwen, Claude,
OpenAI), gated to the Cloudflare / remote-Node / mothership runtimes (never plain local
mode). The policy is evaluated against `(family, effective-route provider)`, so a
residency-guaranteed route (`trustedProviders`, e.g. Bedrock) can exempt an otherwise-blocked
family — data-residency risk is a property of the serving route, not the model weights.
Region-grouped built-in presets (USA / Europe / China / Other) ship as apply-in templates.

Stored on the existing per-account settings config blob (no migration). Enforced through a
single choke point (`ProviderCapabilities`): the `/models` catalog flags blocked models
(`available: false` + `policyBlocked: true`) and the pipeline start guard refuses them
(`model_policy_blocked`). The per-account policy read is cached via a new `accountModelPolicy`
slice of the app cache seam (`AppCaches`), invalidated on the account-settings write.
