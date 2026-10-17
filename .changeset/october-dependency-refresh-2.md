---
'@cat-factory/acceptance-kit': patch
'@cat-factory/agents': patch
'@cat-factory/app': patch
'@cat-factory/binary-generators': patch
'@cat-factory/caching': patch
'@cat-factory/cli': patch
'@cat-factory/consensus': patch
'@cat-factory/contracts': patch
'@cat-factory/delegation-github-actions': patch
'@cat-factory/directory-sync': patch
'@cat-factory/eks': patch
'@cat-factory/gatekeeper-bindings': patch
'@cat-factory/gatekeeper-worker': patch
'@cat-factory/gates': patch
'@cat-factory/gitlab': patch
'@cat-factory/integrations': patch
'@cat-factory/kernel': patch
'@cat-factory/local-server': patch
'@cat-factory/mcp-server': patch
'@cat-factory/node-server': patch
'@cat-factory/observability-langfuse': patch
'@cat-factory/observability-otel': patch
'@cat-factory/orchestration': patch
'@cat-factory/prompt-fragments': patch
'@cat-factory/provider-bedrock': patch
'@cat-factory/provider-cloudflare': patch
'@cat-factory/provider-s3': patch
'@cat-factory/sandbox': patch
'@cat-factory/sandbox-fixtures': patch
'@cat-factory/sdk': patch
'@cat-factory/server': patch
'@cat-factory/spend': patch
'@cat-factory/webhooks': patch
'@cat-factory/worker': patch
'@cat-factory/workspaces': patch
'@cat-factory/conformance': patch
'@cat-factory/acceptance': patch
'@cat-factory/example-custom-agent': patch
'@cat-factory/example-delegated-executor': patch
'@cat-factory/storybook': patch
---

Dependency refresh, direct and transitive (the lockfile is re-resolved from scratch), held to the
24h `minimumReleaseAge` window.

Majors, each taken because its whole peer group could move together:

- **Vitest 5** (`vitest`, `@vitest/coverage-v8`, `@vitest/browser`, `@vitest/browser-playwright`
  at `5.0.5`), now that `@cloudflare/vitest-plugin@1.4.4`, `@storybook/addon-vitest`,
  `@nuxt/test-utils` and `vitest-browser-vue` all accept `^5`. The Worker suite turns Vitest 5's
  new default `fsModuleCache` off: the Workers pool inlines every warm module into one WebSocket
  reply, and this suite's graph (~80MB) exceeds workerd's message limit (`1009 Message is too
  large`).
- **msw 3**, for the component stories. `onUnhandledRequest` became `onUnhandledFrame`, which
  also receives WebSocket frames, and the bundled `mockServiceWorker.js` is regenerated.
- **happy-dom 21** for the SPA's unit tests.

The Workers test pool moves to `@cloudflare/vitest-plugin@1.4.4`, which pins `wrangler@4.151.1`, so
the Cloudflare stack moves with it: workerd `1.20261012.1`, miniflare `5.20261012.1-beta`,
`@cloudflare/workers-types` `5.20261012.1` (the resolved workerd's date) and esbuild `0.28.2`
(the version wrangler and the plugin now pin, so the scoped esbuild overrides follow).

Also the Vercel AI SDK family as one set (`ai@7.0.142`, `@ai-sdk/anthropic@4.0.81`,
`@ai-sdk/openai@4.0.95`, `@ai-sdk/openai-compatible@3.0.70`, `@ai-sdk/amazon-bedrock@5.0.117`,
`@ai-sdk/provider@4.0.28`), the Vue family at `3.5.44`, `@nuxt/ui@4.12.0`, `pinia@4.1.0`,
`storybook@10.6.2`, `undici@8.12.2`, `pg-boss@12.38.0`, `@aws-sdk/client-s3@3.1152.0`,
`@hono/node-server@2.1.5`, `@playwright/test@1.64.1`, and the root toolchain (`turbo@2.11.8`,
`oxlint@1.88.0`, `oxfmt@0.73.0`, `knip@6.41.0`).

Held: the frontend stays on TypeScript 6 (TypeScript 7 ships no classic compiler API for
`vue-tsc`); `@nuxt/fonts` stays on 0.14 because `@nuxt/ui@4.12.0` depends on `^0.14.0`; Drizzle
stays on `1.0.0-rc.4`, still its `rc` tag; `nuxt@4.6.2` is inside the window.
