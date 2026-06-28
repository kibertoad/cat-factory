---
'@cat-factory/agents': patch
'@cat-factory/consensus': patch
'@cat-factory/contracts': patch
'@cat-factory/gates': patch
'@cat-factory/integrations': patch
'@cat-factory/kernel': patch
'@cat-factory/observability-langfuse': patch
'@cat-factory/orchestration': patch
'@cat-factory/prompt-fragments': patch
'@cat-factory/provider-bedrock': patch
'@cat-factory/provider-cloudflare': patch
'@cat-factory/sandbox-fixtures': patch
'@cat-factory/sandbox': patch
'@cat-factory/server': patch
'@cat-factory/spend': patch
'@cat-factory/workspaces': patch
---

Add a `prepublishOnly` build hook so each package is compiled to `dist/` before it is
packed, regardless of how publish is invoked. `dist/` is gitignored and was only built by
the canonical `pnpm ci:publish` flow, so a bare `pnpm publish` could ship an empty shell
(this is what happened to `@cat-factory/gitlab` and `@cat-factory/provider-s3`). The hook
removes that footgun for every publishable library.
