---
'@cat-factory/agents': patch
'@cat-factory/caching': patch
'@cat-factory/cli': patch
'@cat-factory/consensus': patch
'@cat-factory/eks': patch
'@cat-factory/integrations': patch
'@cat-factory/kernel': patch
'@cat-factory/observability-langfuse': patch
'@cat-factory/orchestration': patch
'@cat-factory/provider-bedrock': patch
'@cat-factory/provider-cloudflare': patch
'@cat-factory/provider-s3': patch
'@cat-factory/server': patch
'@cat-factory/worker': patch
'@cat-factory/local-server': patch
'@cat-factory/node-server': patch
'@cat-factory/app': patch
---

Update dependencies to the latest versions within the supply-chain release-age
window. The Vercel AI SDK family stays within the `ai@6` / `@ai-sdk/*` majors
that `workers-ai-provider@^3` peers require (`ai@6.0.219`,
`@ai-sdk/anthropic@3.0.92`, `@ai-sdk/openai@3.0.80`,
`@ai-sdk/openai-compatible@2.0.56`, `@ai-sdk/provider@3.0.13`,
`@ai-sdk/amazon-bedrock@4.0.128`). Other bumps include `@hono/node-server`,
`pg-boss`, `undici`, `markdown-it`, `@aws-sdk/client-s3`, `@clack/prompts`,
`@types/node`, and eligible transitive dependencies. `@cloudflare/workers-types`
is held at `4.x` because `wrangler@4` peers on `^4`.
