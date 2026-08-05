---
'@cat-factory/executor-harness': patch
'@cat-factory/deploy-harness': patch
'@cat-factory/agents': patch
'@cat-factory/app': patch
'@cat-factory/conformance': patch
'@cat-factory/consensus': patch
'@cat-factory/integrations': patch
'@cat-factory/kernel': patch
'@cat-factory/local-server': patch
'@cat-factory/node-server': patch
'@cat-factory/observability-langfuse': patch
'@cat-factory/orchestration': patch
'@cat-factory/provider-bedrock': patch
'@cat-factory/provider-cloudflare': patch
'@cat-factory/provider-s3': patch
'@cat-factory/server': patch
'@cat-factory/worker': patch
---

Refresh the dependency tree and re-roll both runner images.

**Registry deps** (direct ranges plus a full lockfile re-resolution, so transitives move to the newest
release each declared range already admits):

- **AI SDK family** (held to the major that pairs with `workers-ai-provider`): `ai@^7.0.47 → ^7.0.51`,
  `@ai-sdk/anthropic`/`@ai-sdk/openai@^4.0.27 → ^4.0.29`, `@ai-sdk/openai-compatible@^3.0.20 → ^3.0.22`,
  `@ai-sdk/provider@^4.0.4 → ^4.0.5`, `@ai-sdk/amazon-bedrock@^5.0.40 → ^5.0.42`.
- **Runtime deps**: `hono@^4.12.33 → ^4.13.0`, `@hono/node-server@^2.0.12 → ^2.1.0`,
  `pg-boss@^12.26.4 → ^12.27.0`, `undici@^8.9.0 → ^8.10.0`, `ws@^8.21.1 → ^8.21.2`,
  `@aws-sdk/client-s3@^3.1101.0 → ^3.1102.0`, `nuxt@^4.5.0 → ^4.5.1`.
- **Tooling**: `oxlint@^1.76.0 → ^1.77.0`, `oxfmt@^0.61.0 → ^0.62.0`, `publint@^0.3.22 → ^0.3.23`,
  `vitest@^4.1.8 → ^4.1.10`, `@cloudflare/workers-types@^5.20260801.1 → ^5.20260804.1`.

**Runner images** (`@cat-factory/executor-harness` 1.92.1, `@cat-factory/deploy-harness` 0.2.10, with
all six pinned tags synced):

- Executor: Claude Code `2.1.220 → 2.1.221`, and the two lockstep Pi extensions
  `rpiv-todo`/`rpiv-web-tools` `2.3.1 → 2.4.0`. Pi stays at `0.83.0` and Codex at `0.146.0`, both
  already the latest. Claude Code `2.1.222` exists but was published inside the release-age window, so
  `2.1.221` is the newest version the supply-chain rule admits.
- Deploy: `kubectl v1.36.3`, `helm v4.2.3` and `kustomize v5.8.1` are all already the latest, so the
  image moves only for the base re-pin below.
- Both: the `node:26-trixie-slim` base re-pinned to the current multi-arch index digest.

No `minimumReleaseAgeExclude` entries were added: every version above already satisfies the gate.

**Majors**: none were available this sweep except `typescript@6 → 7` for the frontend, which stays on 6
for the same reason as last time. `vue-tsc@3.3.9` still resolves its compiler through
`require.resolve('typescript/lib/tsc')`, and TypeScript 7's `exports` map publishes no such entry, so
the frontend typecheck would fail to resolve at all.
