---
'@cat-factory/kernel': patch
'@cat-factory/contracts': patch
'@cat-factory/spend': patch
'@cat-factory/prompt-fragments': patch
'@cat-factory/agents': patch
'@cat-factory/integrations': patch
'@cat-factory/orchestration': patch
'@cat-factory/server': patch
'@cat-factory/provider-bedrock': patch
'@cat-factory/workspaces': patch
---

Author relative imports with explicit `.js` extensions across the shared backend
packages so their emitted `dist` is directly resolvable by Node's ESM loader (no
bundler required). This lets the Node runtime run the built output on plain Node
(`node dist/main.js`) — no tsx, no esbuild bundle — and is inert for the Cloudflare
Worker (wrangler bundles regardless). `handlebars/runtime` is imported as
`handlebars/runtime.js` for the same reason (its type is sourced from the full
package, type-only). No behaviour or public-API change.
