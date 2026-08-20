---
'@cat-factory/acceptance': patch
'@cat-factory/acceptance-kit': patch
'@cat-factory/agents': patch
'@cat-factory/app': patch
'@cat-factory/binary-generators': patch
'@cat-factory/caching': patch
'@cat-factory/cli': patch
'@cat-factory/conformance': patch
'@cat-factory/consensus': patch
'@cat-factory/contracts': patch
'@cat-factory/deploy-harness': patch
'@cat-factory/eks': patch
'@cat-factory/example-custom-agent': patch
'@cat-factory/executor-harness': patch
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
'@cat-factory/worker': patch
'@cat-factory/workspaces': patch
---

Refresh the whole dependency tree, re-roll both runner images, and move the three bundled agent CLIs.

**Registry deps** (direct ranges plus a full lockfile re-resolution, so transitives move to the
newest release each declared range already admits):

- **AI SDK family** (held to the major that pairs with `workers-ai-provider`): `ai@^7.0.64 → ^7.0.68`,
  `@ai-sdk/anthropic@^4.0.38 → ^4.0.39`, `@ai-sdk/openai@^4.0.41 → ^4.0.43`,
  `@ai-sdk/openai-compatible@^3.0.30 → ^3.0.31`, `@ai-sdk/amazon-bedrock@^5.0.55 → ^5.0.58`.
- **Runtime deps**: `hono@^4.13.1 → ^4.13.3`, `@hono/node-server@^2.1.0 → ^2.1.1`,
  `jose@^6.2.8 → ^6.2.9`, `capnweb@^0.11.0 → ^0.11.1`, `@aws-sdk/client-s3@^3.1109.0 → ^3.1113.0`.
- **Tooling**: `wrangler@^4.122.0 → ^4.124.0`,
  `@cloudflare/workers-types@^5.20260812.1 → ^5.20260819.1` (which is what wrangler 4.124 now
  peer-requires), `@cloudflare/vitest-pool-workers@^0.21.2 → ^0.22.0`, `vitest@^4.1.10 → ^4.1.11`,
  `@vitest/coverage-v8@^4.1.10 → ^4.1.11`, `oxlint@^1.78.0 → ^1.79.0`, `oxfmt@^0.63.0 → ^0.64.0`,
  `publint@^0.3.23 → ^0.3.24`, `turbo@^2.10.9 → ^2.10.11`, `vue-tsc@^3.3.9 → ^3.3.10`,
  `@types/pg@^8.21.0 → ^8.23.1`, pnpm `11.21.0 → 11.22.0`.

**The three agent CLIs the executor image bundles** move together: Pi `0.84.1 → 0.84.2`, Codex
`0.147.0 → 0.148.0`, Claude Code `2.1.231 → 2.1.237`. The Claude Code pin is taken at its newest
release, ahead of the 24h `minimumReleaseAge` window, which is the explicit call that pin's own note
asks to re-make on every bump. Pi's two extensions move in lockstep as their monorepo publishes
them, `2.4.0 → 2.6.2`.

**The UI-tester image** aligns its Playwright with the one the e2e suite drives (`1.61.1 → 1.62.1`),
and moves `@yarnpkg/cli-dist@4.10.3 → 4.18.0` and `serve@14.2.5 → 14.2.6`. **The deploy image** takes
`kubectl v1.36.3 → v1.36.4` and `helm v4.2.3 → v4.2.4`; kustomize is already current at `v5.8.1`.

Both image tags therefore move in this change (`cat-factory-executor:1.127.0`,
`cat-factory-executor-ui:1.127.0`, `cat-factory-deploy:0.2.14`): republishing over a live tag does
not roll a deployment out.

No `minimumReleaseAgeExclude` entries were added and none were needed: every registry bump above
already clears the gate. Five packages had a newer release the gate still withholds
(`@ai-sdk/*`, `ai@7.0.70`, `happy-dom@20.11.6`, `@aws-sdk/client-s3@3.1114.0`,
`@cloudflare/workers-types@5.20260820.1`), so each lands one release short of the registry's head.
`drizzle-orm`/`drizzle-kit` stay on `1.0.0-rc.4`: the only newer builds are commit-suffixed
snapshots, not a released `rc.5`. Majors available but deliberately not taken here, each being its
own change: `@changesets/cli@3`, `@stryker-mutator/*@10`, and TypeScript 7 for the two frontend
packages still on 6.
