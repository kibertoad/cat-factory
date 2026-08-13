---
'@cat-factory/agents': patch
'@cat-factory/consensus': patch
'@cat-factory/gatekeeper-worker': patch
'@cat-factory/integrations': patch
'@cat-factory/kernel': patch
'@cat-factory/node-server': patch
'@cat-factory/orchestration': patch
'@cat-factory/provider-bedrock': patch
'@cat-factory/provider-cloudflare': patch
'@cat-factory/provider-s3': patch
'@cat-factory/worker': patch
---

Refresh every direct and transitive dependency to the newest version the 24h
`minimumReleaseAge` supply-chain gate admits, staying inside each package's current major.

The Vercel AI SDK family moves within the majors `workers-ai-provider` pairs with (`ai@7.0.62`,
`@ai-sdk/anthropic@4.0.38` / `openai@4.0.40` / `openai-compatible@3.0.30` /
`amazon-bedrock@5.0.54`). The Cloudflare toolchain moves together: `wrangler@4.121.0`,
`@cloudflare/workers-types@5.20260812.1` and `@cloudflare/vitest-pool-workers@0.21.1`, whose only
change over 0.20.3 is the wrangler and miniflare it bundles, so the pool now carries the same
wrangler the workspace declares instead of one release behind it.

`esbuild` gains three scoped `pnpm-workspace.yaml` overrides pinning vite's, tsx's and nitropack's
loose ranges to the 0.28.1 that wrangler and `@cloudflare/vitest-pool-workers` pin exactly. Without
them a re-resolve hands vite's optional PEER slot the newer 0.28.2 and the tree gains a second
esbuild; because pnpm resolves an auto-installed peer without its own `optionalDependencies`, that
copy never gets its platform binary and esbuild's postinstall aborts the entire install. The
overrides are deliberately scoped rather than top-level: `drizzle-kit`, `@intlify/bundle-utils` and
`fontless` declare narrower ranges that a blanket pin would force them out of.

Held back deliberately: `@changesets/cli` 3.0.0 and, in the frontend, `typescript` 7 (Nuxt 4.5.2
itself depends on `typescript@6.0.3`). No `minimumReleaseAgeExclude` entries were added: every
version above already satisfies the gate.
