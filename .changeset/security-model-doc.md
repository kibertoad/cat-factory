---
---

Docs only: add `backend/docs/security-model.md` — the layer-by-layer trust-boundary model between
an agent's decisions and the VCS write path (prompt-injection posture, credential precedence and
scoping, merge gating, operator hardening checklist, known gaps) — point CLAUDE.md and both READMEs
at it, and correct the backend README's claim that installation tokens are cached in D1 (they are
in-memory only, deliberately never persisted).
