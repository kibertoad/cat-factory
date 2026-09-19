---
'@cat-factory/provider-cloudflare': patch
'@cat-factory/provider-bedrock': patch
'@cat-factory/orchestration': patch
'@cat-factory/integrations': patch
'@cat-factory/provider-s3': patch
'@cat-factory/node-server': patch
'@cat-factory/consensus': patch
'@cat-factory/kernel': patch
'@cat-factory/agents': patch
'@cat-factory/server': patch
'@cat-factory/worker': patch
'@cat-factory/app': patch
---

Dependency refresh, direct and transitive, held to the 24h `minimumReleaseAge` window.

The Vercel AI SDK family moves as one set (`ai@7.0.102 → 7.0.106` with `@ai-sdk/anthropic@4.0.57`,
`@ai-sdk/openai@4.0.70`, `@ai-sdk/openai-compatible@3.0.52`, `@ai-sdk/amazon-bedrock@5.0.87`,
`@ai-sdk/provider@4.0.17`), staying inside the majors `workers-ai-provider@4` pairs with. Every
member resolves the same `@ai-sdk/provider@4.0.17` and `@ai-sdk/provider-utils@5.0.44`, so the
provider interface stays a single identity across the proxy and the inline callers.

Also `@aws-sdk/client-s3@3.1135.0`, `pg-boss@12.33.1`, `knip@6.37.0`, and on the frontend the whole
pinned Vue family to `3.5.43` with `vue-router` to `5.3.1`.

`wrangler` and `@cloudflare/workers-types` deliberately stay put: `@cloudflare/vitest-pool-workers`
still pins `wrangler@4.124.0`, and the types' version IS the resolved workerd's date, so moving
either alone splits the runtime the Worker suite proves from the one that ships.
