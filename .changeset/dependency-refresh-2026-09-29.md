---
'@cat-factory/agents': patch
'@cat-factory/consensus': patch
'@cat-factory/integrations': patch
'@cat-factory/kernel': patch
'@cat-factory/orchestration': patch
'@cat-factory/provider-bedrock': patch
'@cat-factory/provider-cloudflare': patch
'@cat-factory/provider-s3': patch
'@cat-factory/server': patch
'@cat-factory/worker': patch
'@cat-factory/local-server': patch
'@cat-factory/node-server': patch
'@cat-factory/mcp-server': patch
---

Dependency refresh within current majors, each at the newest release older than the 24h
`minimumReleaseAge` window: the Vercel AI SDK family (`ai` 7.0.120, `@ai-sdk/*` 4.x, `openai-compatible`
3.0.58, `amazon-bedrock` 5.0.99), `@aws-sdk/client-s3`, `@modelcontextprotocol/sdk` 1.31.0, `pg-boss`
12.35.0, `ws` 8.22.0 and `undici` 8.11.2. `publicApiAuth.refuse` now declares its return type, because
hono 4.13.10 ships bundled declarations whose inferred `c.json` return type a declaration emit can no
longer name.
