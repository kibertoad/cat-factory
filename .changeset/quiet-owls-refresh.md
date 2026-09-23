---
'@cat-factory/provider-cloudflare': patch
'@cat-factory/observability-langfuse': patch
'@cat-factory/provider-bedrock': patch
'@cat-factory/orchestration': patch
'@cat-factory/integrations': patch
'@cat-factory/provider-s3': patch
'@cat-factory/node-server': patch
'@cat-factory/consensus': patch
'@cat-factory/caching': patch
'@cat-factory/kernel': patch
'@cat-factory/agents': patch
'@cat-factory/server': patch
'@cat-factory/worker': patch
'@cat-factory/app': patch
---

Dependency refresh, direct and transitive, held to the 24h `minimumReleaseAge` window.

One major moves with it: `layered-loader` goes `16.1.1` to `17.0.0`, whose only change is that
`getMany` now includes `null` in its return type. Nothing here calls `getMany`, so the caching layer
takes it with no source change.

The Vercel AI SDK family moves as one set (`ai@7.0.111` with `@ai-sdk/anthropic@4.0.60`,
`@ai-sdk/openai@4.0.72`, `@ai-sdk/amazon-bedrock@5.0.91`), staying inside the majors
`workers-ai-provider@4` pairs with. Every member resolves the same `@ai-sdk/provider@4.0.17` and
`@ai-sdk/provider-utils@5.0.45`, so the provider interface stays a single identity across the proxy
and the inline callers. Also `@aws-sdk/client-s3@3.1138.0`, `pg-boss@12.33.6`, `undici@8.11.0`,
`@nuxt/ui@4.11.2`, `turbo@2.11.3`, `oxlint@1.85.0` and `oxfmt@0.70.0`.

Every hold was re-verified at HEAD rather than assumed, and all of them still bind.
`@cloudflare/vitest-pool-workers@0.22.0` is still its newest release, peer-requires vitest `^4.1.0`
and pins `wrangler@4.124.0` exactly, so vitest and `@vitest/coverage-v8` stay on 4 and wrangler,
workerd, miniflare and `@cloudflare/workers-types` stay where they are. The frontend stays on
TypeScript 6: TypeScript 7 ships no compiler API for `vue-tsc` to load. Drizzle stays on
`1.0.0-rc.4`, the newest non-snapshot release of its line, and the Vue family pins (`vue@3.5.43`,
`vue-router@5.3.1`, `esbuild@0.28.1`, `@modular-frontend/core@0.6.0`) are already what their
consumers need.
