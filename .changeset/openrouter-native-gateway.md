---
'@cat-factory/agents': minor
'@cat-factory/contracts': minor
'@cat-factory/integrations': minor
'@cat-factory/kernel': minor
'@cat-factory/server': minor
'@cat-factory/spend': minor
'@cat-factory/orchestration': patch
'@cat-factory/conformance': patch
'@cat-factory/local-server': patch
'@cat-factory/node-server': patch
'@cat-factory/worker': patch
'@cat-factory/app': patch
---

Treat OpenRouter as the gateway it is, rather than as one more OpenAI-compatible vendor.

**Its own client.** `openrouter` now resolves through `@openrouter/ai-sdk-provider`
(`openRouterResolver`) instead of the generic `createOpenAICompatible`; every other
OpenAI-compatible provider is unchanged. The dispatch is made once, in
`directOpenAiCompatibleResolver`, which both entry points that build a provider from a leased key
route through.

**Cost and upstream are now RECORDED rather than derived.** Usage accounting is requested on both
model paths, so `llm_call_metrics` gains `reported_cost_usd` (the gateway's own USD ledger figure)
and `upstream_provider` (which vendor actually served the call). Both are nullable and null is
load-bearing: every other cost on the table is derived from the spend price table, so a 0 would
report an unpriced call as free. **Break:** the two columns are added to the D1 telemetry store, the
Postgres `telemetry` schema and local mode's SQLite store; existing rows read NULL, which is the
correct answer for them.

**`supportsStructuredOutputs` is now set** on the generic OpenAI-compatible client for cloud
vendors. Without it the SDK silently rewrites a schema-carrying request to `{ type: 'json_object' }`
and drops the schema. Nothing in this repo passes a schema today, so this closes a trap rather than
changing behaviour; per-user local runners stay on the SDK default.

**The `/models` catalog reads what it was dropping**: the conditional `overrides` pricing bands
(folded to their maximum), the account `discount`, both cache classes, `expiration_date` and
`canonical_slug`. Published cache rates now reach the spend table instead of the derived
multipliers, and a model's withdrawal date is shown in the catalog picker.

**Prompt caching is no longer reported as absent for every gateway model.** `providerCachePolicy`
takes the model, so an `openrouter:deepseek/…` slug resolves to its upstream's policy;
anthropic-behind-a-gateway stays `none`, because nothing on that path sends `cache_control`.

**New env var `OPENROUTER_DATA_COLLECTION`** (default `deny`, stricter than the vendor's own
default): whether OpenRouter may route to an upstream that retains prompts.

**New check `scripts/check-openrouter-pins.mjs`** re-reads the live catalogue against the spend
table's pinned slugs. Its first run found three pins metering below the live rate, one
(`deepseek/deepseek-v4-pro`) by nearly 3x; all three are repinned here.
