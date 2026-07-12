---
'@cat-factory/executor-harness': patch
'@cat-factory/agents': patch
'@cat-factory/app': patch
'@cat-factory/caching': patch
'@cat-factory/cli': patch
'@cat-factory/consensus': patch
'@cat-factory/contracts': patch
'@cat-factory/eks': patch
'@cat-factory/gates': patch
'@cat-factory/gitlab': patch
'@cat-factory/integrations': patch
'@cat-factory/kernel': patch
'@cat-factory/local-server': patch
'@cat-factory/node-server': patch
'@cat-factory/observability-langfuse': patch
'@cat-factory/orchestration': patch
'@cat-factory/prompt-fragments': patch
'@cat-factory/provider-bedrock': patch
'@cat-factory/provider-cloudflare': patch
'@cat-factory/provider-s3': patch
'@cat-factory/sandbox': patch
'@cat-factory/sandbox-fixtures': patch
'@cat-factory/server': patch
'@cat-factory/spend': patch
'@cat-factory/worker': patch
'@cat-factory/workspaces': patch
---

Update workspace dependencies (direct + transitive) to the newest versions published before the
`minimumReleaseAge` supply-chain cutoff. No source changes — dependency ranges + the lockfile only.

- Refreshed direct deps to their newest cooldown-compliant releases: `wrangler` 4.110.0, `hono`
  4.12.29, `vitest` / `@vitest/coverage-v8` 4.1.10, `oxlint` 1.73.0, `knip` 6.26.0, `msw` 2.15.0,
  `pg-boss` 12.26.0, `sherif` 1.13.0, `turbo` 2.10.4, `vue-tsc` 3.3.7, `@types/node` 26.1.1,
  `@nuxtjs/i18n` 10.4.1, `@aws-sdk/client-s3` 3.1085.0.
- `typescript` moved off the `7.0.1-rc` prerelease to the stable `7.0.2` release across every
  package that used the RC (the TS-6 world — the frontend layer and the two runner harnesses —
  stays on `^6.0.3`).
- Vercel AI SDK family held to the `ai@6`-compatible majors that `workers-ai-provider@3.3.1` peers
  require (`ai` 6.0.224, `@ai-sdk/anthropic|openai|provider` on 3.x, `@ai-sdk/openai-compatible` on
  2.x, `@ai-sdk/amazon-bedrock` 4.x) — no v7/v5 major bumps.
- Coding (`executor-harness`) and deploy runner harnesses updated too; their image tags and the
  three hand-maintained pins were bumped in lockstep, so the runner images must be re-published +
  deployed for the new tags to roll out.
