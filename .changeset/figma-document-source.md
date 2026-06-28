---
'@cat-factory/contracts': minor
'@cat-factory/integrations': minor
'@cat-factory/prompt-fragments': minor
'@cat-factory/worker': minor
'@cat-factory/node-server': minor
---

feat(documents): add Figma as a design-context document source

Implements the Figma half of the design record in
`backend/docs/figma-claude-design-context.md`. Figma becomes a new
`DocumentSourceProvider` (`source='figma'`) authenticated by a per-workspace
personal access token, reusing the whole documents integration (connection table,
sealing, link plumbing, controller, `.cat-context/` materialization). `fetchDocument`
renders a frame/file's layout tree, text, components-used and (Enterprise-gated)
design tokens to Markdown, with a best-effort rendered-preview URL on a reference
line. Wired symmetrically into both the Cloudflare and Node facades (and the
`DOCUMENT_SOURCES` allow-list), gated by a cross-runtime conformance case. Adds the
`design.figma-context` prompt fragment for frontend agents. Claude Design is
intentionally deferred (no server-to-server credential yet — see the design record).
