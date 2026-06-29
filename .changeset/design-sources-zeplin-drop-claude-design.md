---
"@cat-factory/contracts": minor
"@cat-factory/kernel": minor
"@cat-factory/integrations": minor
"@cat-factory/prompt-fragments": minor
"@cat-factory/worker": minor
"@cat-factory/node-server": minor
"@cat-factory/server": patch
"@cat-factory/orchestration": patch
"@cat-factory/app": patch
---

Design-context sources: add Zeplin, generalize the abstraction, drop the Claude Design backend connector.

- **New source: Zeplin** (`source='zeplin'`, per-workspace Bearer PAT) — a real server-fetchable
  REST handoff source exposing screens, components and design tokens. On by default; a no-op until a
  workspace connects it.
- **De-Figma-shaped abstraction:** Figma and Zeplin now map into a shared, source-neutral
  `DesignContext` model rendered by `renderDesignContext` (`integrations/documents/design.logic.ts`).
  The per-source prompt fragments collapse into a single `design.context` fragment.
- **Breaking — Claude Design backend connector removed.** Its only real read path is login-bound
  (Claude Code's `DesignSync` / `/design-sync`, via the user's claude.ai login), so a headless
  multi-tenant backend can never authenticate. The provider, the `'claude-design'` source value, the
  descriptor `credentialScope` field, and the entire per-user `user_document_connections` store
  (D1 + Drizzle tables, repositories, kernel ports, scope-aware `DocumentConnectionService`) are
  removed — all document sources are workspace-scoped again. The supported Claude Design workflow is
  now: `/design-sync` into the repo → commit → agents read it as checkout files. Stale
  `user_document_connections` rows are dropped (D1 migration `0020`, Drizzle drop migration); per the
  pre-1.0 policy there is no data migration.
