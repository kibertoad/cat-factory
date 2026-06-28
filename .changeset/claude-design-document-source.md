---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/integrations': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': minor
'@cat-factory/prompt-fragments': minor
'@cat-factory/worker': minor
'@cat-factory/node-server': minor
---

feat(documents): add Claude Design as a per-user design-context document source

Implements the Claude Design half of the design record in
`backend/docs/figma-claude-design-context.md`. Claude Design becomes a new
`DocumentSourceProvider` (`source='claude-design'`) that reuses the whole documents
integration (link plumbing, controller, `.cat-context/` materialization, prompt
fragment), with a deterministic design-system normalizer that turns a project's
`_ds_manifest.json` / `@dsCard`-marked component HTML + CSS custom properties into the
same `### Components` / `### Design tokens` Markdown shape the Figma provider emits — so
it earns its place over a plain HTML upload.

Auth is a **personal per-user PAT**, supported on every runtime: a new descriptor flag
`credentialScope: 'user'` routes such a source to a new per-user
`user_document_connections` store (D1 ⇄ Drizzle, encrypted at rest under a distinct HKDF
info), keyed by the acting user and never shared with the workspace. `DocumentConnectionService`
becomes scope-aware; the import path threads the acting user. Workspace-scoped sources
(Notion/Confluence/GitHub/Figma/Linear) are unchanged. The acting user falls back to the
empty user id ONLY when auth is disabled (dev-open / single-user local mode) so those
deployments still connect; when auth is enabled the controller fails closed with a 401
rather than silently using the shared empty-user bucket.

Claude Design is **opt-in**, not on by default: its credentialed project-read API is
still provisional (the read is claude.ai-login-bound, no per-user service token yet), so
it is excluded from the default `DOCUMENT_SOURCES` set and must be enabled explicitly
(`DOCUMENT_SOURCES=…,claude-design`) once the API is real — every other source stays on
by default.

Also hoists the host-pinned `safeFetch`/SSRF guard/capped-read into a shared
`documents/http.ts` reused by Figma and Claude Design. Wired symmetrically into both
facades and gated by a new cross-runtime conformance case (per-user connect → list →
disconnect).
