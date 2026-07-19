---
'@cat-factory/agents': patch
'@cat-factory/app': patch
'@cat-factory/consensus': patch
'@cat-factory/executor-harness': patch
'@cat-factory/integrations': patch
'@cat-factory/kernel': patch
'@cat-factory/local-server': patch
'@cat-factory/node-server': patch
'@cat-factory/observability-otel': patch
'@cat-factory/orchestration': patch
'@cat-factory/provider-bedrock': patch
'@cat-factory/provider-cloudflare': patch
'@cat-factory/provider-s3': patch
'@cat-factory/server': patch
'@cat-factory/worker': patch
---

chore(deps): in-range dependency sweep + transitive upgrade and dedupe

Update all dependencies within their existing semver ranges across the
workspace (including the harness packages), run a transitive upgrade and
`pnpm dedupe`, and re-adopt `@modular-vue/journeys@1.2.0` now that its neutral
engine (`@modular-frontend/journeys-engine@1.8.0`) is published.

- The Vercel AI SDK stays on `ai@6` / `@ai-sdk/*@3`: the newest
  `workers-ai-provider` (3.3.1) still peer-requires `ai@^6`, so a v7 bump
  remains blocked (moves within the pinned majors only).
- `@modular-frontend/core` is pinned to a single `0.3.0` via a pnpm override:
  the 1.8.0 journeys engine hard-depends on `0.3.0` while the sibling
  `@modular-vue/*` bindings still range `^0.2.0`, which otherwise bundles two
  copies and splits the `JourneyRuntime` type. 0.3.0 is a strict superset
  (adds `discard`). Drop the override once the bindings widen their peer range.
- `@cat-factory/executor-harness` runtime deps (`hono`, `@hono/node-server`)
  moved within range, so the runner-image tag is bumped and the three pins are
  re-synced (image publish/deploy is a maintainer follow-up).
