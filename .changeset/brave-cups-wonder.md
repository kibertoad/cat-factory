---
'@cat-factory/provider-cloudflare': patch
'@cat-factory/provider-bedrock': patch
'@cat-factory/orchestration': patch
'@cat-factory/integrations': patch
'@cat-factory/provider-s3': patch
'@cat-factory/node-server': patch
'@cat-factory/consensus': patch
'@cat-factory/contracts': patch
'@cat-factory/kernel': patch
'@cat-factory/agents': patch
'@cat-factory/server': patch
'@cat-factory/worker': patch
'@cat-factory/app': patch
'@cat-factory/gatekeeper-bindings': patch
'@cat-factory/acceptance-kit': patch
'@cat-factory/mcp-server': patch
'@cat-factory/caching': patch
'@cat-factory/cli': patch
'@cat-factory/sdk': patch
'@cat-factory/eks': patch
'@cat-factory/acceptance': patch
---

Dependency refresh, direct and transitive, held to the 24h `minimumReleaseAge` window.

Three majors move with it. The `@toad-contracts/*` family goes `0.x` to `1.0.0`, which redesigns
how a contract declares a non-JSON response: a status code now carries a media-type content map
rather than a tagged marker, and the `ContractNoBody` symbol is request-body-only. Every response
declaring it becomes `noBodyResponse()`, the form that survives; the symbol stays where it already
meant a request. `@vueuse/core` goes to `15.0.0` and `@openrouter/ai-sdk-provider` to `3.1.0`.

The Vercel AI SDK family moves as one set (`ai@7.0.107` with `@ai-sdk/anthropic@4.0.58`,
`@ai-sdk/openai@4.0.71`, `@ai-sdk/openai-compatible@3.0.53`, `@ai-sdk/amazon-bedrock@5.0.88`),
staying inside the majors `workers-ai-provider@4` pairs with, so `@ai-sdk/provider` keeps a single
identity across the proxy and the inline callers. Also `@aws-sdk/client-s3@3.1136.0`,
`pg-boss@12.33.2`, `turbo@2.11.2` and `@types/node@26.6.2`.

`vitest` stays on 4: `@cloudflare/vitest-pool-workers@0.22.0` peer-requires `^4.1.0`, so taking
vitest 5 would leave the Worker suite running against a pool that never declared it.
`wrangler` and `@cloudflare/workers-types` stay put for the same kind of reason: the pool still
pins `wrangler@4.124.0`, and the types' version IS the resolved workerd's date.
