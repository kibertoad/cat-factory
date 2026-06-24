---
"@cat-factory/agents": patch
"@cat-factory/app": patch
"@cat-factory/consensus": patch
"@cat-factory/contracts": patch
"@cat-factory/integrations": patch
"@cat-factory/kernel": patch
"@cat-factory/local-server": patch
"@cat-factory/node-server": patch
"@cat-factory/observability-langfuse": patch
"@cat-factory/orchestration": patch
"@cat-factory/prompt-fragments": patch
"@cat-factory/provider-bedrock": patch
"@cat-factory/provider-cloudflare": patch
"@cat-factory/sandbox": patch
"@cat-factory/sandbox-fixtures": patch
"@cat-factory/server": patch
"@cat-factory/spend": patch
"@cat-factory/worker": patch
"@cat-factory/workspaces": patch
---

Re-release all publishable packages. The previous release bumped these on `main` but never reached npm (the publish job was never triggered), so npm is a release behind. This changeset re-triggers the release so every package publishes.
