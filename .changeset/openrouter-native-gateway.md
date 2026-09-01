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

**`supportsStructuredOutputs` is now set** on the generic OpenAI-compatible client for the cloud
VENDORS. Without it the SDK silently rewrites a schema-carrying request to `{ type: 'json_object' }`
and drops the schema. Nothing in this repo passes a schema today, so this closes a trap rather than
changing behaviour. It is withheld from the upstreams nobody here can vouch for: per-user local
runners (which never come through this path anyway) and the operator-hosted `bifrost` / `litellm`
gateways, whose model ids are the operator's own aliases and routinely front an Ollama or vLLM
model that answers a `json_schema` request with a 400.

**The `/models` catalog reads what it was dropping**: the conditional `overrides` pricing bands
(folded to their maximum), both cache classes and the 1-hour write fallback, `expiration_date` and
`canonical_slug`. A published cache rate now reaches the spend table instead of the derived
multiplier, unless it is zero, which cannot be told apart from a placeholder for a class the
gateway does not bill separately and would meter every cache hit free. A model's withdrawal date
is shown in the catalog picker.

**Prompt caching is no longer reported as absent for every gateway model.** `providerCachePolicy`
takes the model, so an `openrouter:deepseek/…` slug resolves to the policy stated for its vendor
prefix. Those are stated per prefix rather than borrowed from the direct provider of the same
name, because the two genuinely differ: OpenRouter's Moonshot route caches automatically while our
direct `moonshot` does not, and its Alibaba route needs explicit breakpoints while direct Qwen
does not. Anthropic (and now Qwen) behind a gateway stays `none`, because nothing on that path
sends `cache_control`. **Break:** the rule moved from `@cat-factory/kernel` to
`@cat-factory/contracts` (kernel re-exports it unchanged) so the SPA can read the same function
instead of mirroring it in a Vue constant, which had already drifted.

**Two new env vars, because both routing constraints can empty the upstream pool.**
`OPENROUTER_DATA_COLLECTION` (default `deny`, stricter than the vendor's own) is whether OpenRouter
may route to a prompt-retaining upstream; `OPENROUTER_REQUIRE_PARAMETERS` (default `true`) is
whether it must route only to an upstream advertising every parameter the request carries. A pool
narrowed to nothing is a 404, not a degraded call, so the proxy recognises that refusal and records
which constraint could have caused it: the gateway cannot say, since our request is the only place
both are stated.

**New check `scripts/check-openrouter-pins.mjs`** re-reads the live catalogue against the spend
table's pinned slugs, comparing all three pinned classes: input, output, and the cache-READ rate a
row names only where the vendor departs from the derived floor (so nothing else follows it when the
vendor moves). Its runs found four pins metering below the live rate, one
(`deepseek/deepseek-v4-pro`) by nearly 3x; all four are repinned here.

**Reported cost and upstream are rendered**, in the observability panel's call list: the upstream
beside `provider:model`, the gateway's own figure in the expanded row. They stay out of the spend
rollups, which remain derived end to end, because a rollup mixing a measured figure for one
provider's rows with an estimate for the rest answers a different question per row.

**The inline instrumented provider now REFUSES to stream** rather than passing an unrecorded call
through. Nothing inline streams today (the recorder hard-codes `streaming: false` for that reason),
and a streamed call would have reached no sink at all, which downstream is indistinguishable from a
step that spent nothing.
