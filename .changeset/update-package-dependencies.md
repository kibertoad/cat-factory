---
'@cat-factory/agents': patch
'@cat-factory/consensus': patch
'@cat-factory/integrations': patch
'@cat-factory/kernel': patch
'@cat-factory/orchestration': patch
'@cat-factory/provider-bedrock': patch
'@cat-factory/provider-cloudflare': patch
'@cat-factory/worker': patch
'@cat-factory/node-server': patch
'@cat-factory/local-server': patch
---

Refresh dependencies to their latest release-age-compliant versions: the Vercel AI
SDK family within its `workers-ai-provider`-compatible majors (`ai` 6.0.214,
`@ai-sdk/anthropic` 3.0.89, `@ai-sdk/openai` 3.0.77, `@ai-sdk/openai-compatible`
2.0.54, `@ai-sdk/amazon-bedrock` 4.0.124), `drizzle-orm`/`drizzle-kit` 1.0.0-rc.4,
and `yaml` 2.9.0, plus refreshed transitive resolutions.
