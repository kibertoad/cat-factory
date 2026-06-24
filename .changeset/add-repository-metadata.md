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

Add `repository` metadata (url + monorepo `directory`) to every published package.json. npm provenance attestation rejected the previous release because `repository.url` was empty and could not be matched against the source repo; declaring it lets the publish (and provenance) succeed, and re-triggers publishing of all packages from the failed release.
