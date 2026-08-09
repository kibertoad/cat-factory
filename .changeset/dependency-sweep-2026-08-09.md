---
'@cat-factory/agents': patch
'@cat-factory/app': patch
'@cat-factory/caching': patch
'@cat-factory/cli': patch
'@cat-factory/consensus': patch
'@cat-factory/eks': patch
'@cat-factory/gatekeeper-bindings': patch
'@cat-factory/gatekeeper-worker': patch
'@cat-factory/integrations': patch
'@cat-factory/kernel': patch
'@cat-factory/local-server': patch
'@cat-factory/mcp-server': patch
'@cat-factory/node-server': patch
'@cat-factory/orchestration': patch
'@cat-factory/provider-bedrock': patch
'@cat-factory/provider-cloudflare': patch
'@cat-factory/provider-s3': patch
'@cat-factory/sdk': patch
'@cat-factory/server': patch
'@cat-factory/worker': patch
---

Refresh every direct and transitive dependency to the newest version the 24h
`minimumReleaseAge` supply-chain gate admits, staying inside each package's current major.

The Vercel AI SDK family moves within the majors `workers-ai-provider` pairs with
(`ai@7.0.58`, `@ai-sdk/*@4.0.36` / `openai-compatible@3.0.27` / `amazon-bedrock@5.0.50`), and the
Vue singleton pin plus its `@vue/*` overrides move together to 3.5.41 so the SPA still bundles
exactly one Vue.
