---
---

Docs only: add `backend/docs/custom-agent-roles.md` — the authoring guide for a custom agent
kind's ROLE (system-prompt composition layers, user-prompt builder contract, traits, bundled-skill
and MCP tool-server authoring, per-kind knobs, registration order + verification) — and
cross-reference it from `custom-agents.md`, `CLAUDE.md`, and the agents package `AGENTS.md`.
Also fixes a stale kernel JSDoc on `McpSecretRef.key` (comment-only) that described a `${key}`
placeholder mechanism the implementation never had — the value rides `header`/`headerTemplate`.
