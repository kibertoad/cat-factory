---
'@cat-factory/observability-langfuse': patch
'@cat-factory/provider-cloudflare': patch
'@cat-factory/example-custom-agent': patch
'@cat-factory/provider-bedrock': patch
'@cat-factory/sandbox-fixtures': patch
'@cat-factory/local-server': patch
'@cat-factory/integrations': patch
'@cat-factory/orchestration': patch
'@cat-factory/node-server': patch
'@cat-factory/provider-s3': patch
'@cat-factory/contracts': patch
'@cat-factory/consensus': patch
'@cat-factory/kernel': patch
'@cat-factory/server': patch
'@cat-factory/agents': patch
'@cat-factory/worker': patch
'@cat-factory/app': patch
---

Update dependencies to latest.

- `undici` 7→8 (test-only `MockAgent`). undici's MockAgent must match Node's
  bundled undici to intercept the global `fetch`; Node 26 bundles undici 8.5.0,
  so the test runner / CI is pinned to **Node 26**. Production runtime is
  unaffected — `undici` is a dev/test dependency only, and the service still runs
  on any Node >=20 (e.g. the example `deploy/node` image stays on Node 24).
- Minor/patch bumps: `wrangler` 4.105, `@cloudflare/*`, `@types/node` 26.0.1,
  `vue` 3.5.39, `msw` 2.14.6, `valibot` 1.4.2, `workers-ai-provider` 3.2.1,
  `@toad-contracts/*` (core 0.4.0, valibot 0.5.0, hono/testing/http-client 0.3.2),
  `@aws-sdk/client-s3` 3.1075.
- The AI SDK (`ai`, `@ai-sdk/*`) is intentionally held at v6 / v3-v4: the latest
  `workers-ai-provider` (3.2.1, the Cloudflare Workers AI provider) still peers on
  `ai@^6` / `@ai-sdk/provider@^3` and is not yet compatible with `ai` v7.
- Pinned the whole Vue runtime family to one version via a pnpm `override`
  (`vue` + `@vue/*` → 3.5.39). Bumping `vue` to 3.5.39 left Nuxt 4.4.8's
  transitive deps pinning parts of the graph to 3.5.38, so two copies of Vue were
  bundled into the SPA; Vue's render internals are module-level singletons, so the
  second copy crashed the app on boot (`Cannot read properties of null (reading
  'ce')` in `renderSlot`) — a blank 500 page that hung the whole e2e suite. One
  version = one singleton.
- GitHub Actions: `actions/checkout` v6→v7, `pnpm/action-setup` v6.0.9,
  `zizmorcore/zizmor-action` v0.5.7, `changesets/action` pinned to v1.9.0. CI Node 24→26.
