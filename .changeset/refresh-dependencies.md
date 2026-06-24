---
"@cat-factory/agents": patch
"@cat-factory/consensus": patch
"@cat-factory/integrations": patch
"@cat-factory/kernel": patch
"@cat-factory/observability-langfuse": patch
"@cat-factory/orchestration": patch
"@cat-factory/provider-bedrock": patch
"@cat-factory/provider-cloudflare": patch
"@cat-factory/server": patch
"@cat-factory/worker": patch
"@cat-factory/node-server": patch
"@cat-factory/local-server": patch
"@cat-factory/app": patch
---

Refresh dependencies to latest. Notable major bumps: TypeScript 5→6 (tooling
packages), vitest 3→4, pino 9→10, `@hono/node-server` 1→2, `@hono/valibot-validator`
0.5→0.6, happy-dom 15→20, and `@types/node` →26. Patch/minor refreshes for `ai`,
`hono`, `wrangler`, `pg-boss`, `ws`, `@ai-sdk/*`, `oxlint`, and the Cloudflare
workers tooling.
