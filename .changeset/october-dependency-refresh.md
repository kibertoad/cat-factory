---
'@cat-factory/acceptance': patch
'@cat-factory/acceptance-kit': patch
'@cat-factory/agents': patch
'@cat-factory/caching': patch
'@cat-factory/cli': patch
'@cat-factory/consensus': patch
'@cat-factory/eks': patch
'@cat-factory/integrations': patch
'@cat-factory/kernel': patch
'@cat-factory/observability-otel': patch
'@cat-factory/orchestration': patch
'@cat-factory/provider-bedrock': patch
'@cat-factory/provider-cloudflare': patch
'@cat-factory/provider-s3': patch
'@cat-factory/server': patch
'@cat-factory/worker': patch
'@cat-factory/local-server': patch
'@cat-factory/node-server': patch
'@cat-factory/app': patch
'@cat-factory/gatekeeper-worker': patch
'@cat-factory/gatekeeper-bindings': patch
'@cat-factory/mcp-server': patch
'@cat-factory/sdk': patch
---

Dependency refresh, direct and transitive, held to the 24h `minimumReleaseAge` window.

The Worker test pool moves from `@cloudflare/vitest-pool-workers@0.22.0` to its renamed successor
`@cloudflare/vitest-plugin@1.3.7`. The old package is deprecated and receives no further releases;
the new one exports the same `cloudflareTest`, `readD1Migrations` and `/types` entry, so only the
import specifiers change. It pins `wrangler@4.148.0`, so the Cloudflare stack moves with it:
wrangler `4.124.0` to `4.148.0`, workerd `1.20260815.1` to `1.20261006.1`, miniflare to
`5.20261006.0-alpha`, and `@cloudflare/workers-types` to `5.20261006.1`, the resolved workerd's
date. esbuild stays on `0.28.1`, which wrangler still pins.

The Vercel AI SDK family moves as one set (`ai@7.0.131`, `@ai-sdk/anthropic@4.0.75`,
`@ai-sdk/openai@4.0.87`, `@ai-sdk/openai-compatible@3.0.65`, `@ai-sdk/amazon-bedrock@5.0.109`,
`@ai-sdk/provider@4.0.24`), still one `@ai-sdk/provider` identity across every caller. Also
`nuxt@4.6.0` with `vue-router@5.4.0`, `@nuxt/ui@4.11.3`, `hono@4.13.13`,
`@modelcontextprotocol/sdk@1.32.1`, the OpenTelemetry SDK `2.12.0` / `0.223.0`, `pg-boss@12.37.0`,
`pino@10.4.0`, `@aws-sdk/client-s3@3.1147.0`, `@playwright/test@1.64.0`, and the root toolchain
(`turbo@2.11.7`, `oxlint@1.87.0`, `oxfmt@0.72.0`, `knip@6.40.0`).

Held: vitest and `@vitest/coverage-v8` stay on 4, because the plugin release inside the window
peer-requires vitest `^4.1.0`. msw stays on 2 for the same reason: vitest 4's mocker peers
`msw@^2`. The frontend stays on TypeScript 6, since TypeScript 7 ships no classic compiler API for
`vue-tsc`.
