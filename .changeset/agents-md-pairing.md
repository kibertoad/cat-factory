---
---

Docs and CI only: pair every nested `AGENTS.md` with a sibling `CLAUDE.md` that imports it
(`@AGENTS.md`), so Claude Code loads the per-package guidance the root `CLAUDE.md` would otherwise
switch off, and add `scripts/check-agents-md-pairing.mjs` to keep the pairing from drifting.
