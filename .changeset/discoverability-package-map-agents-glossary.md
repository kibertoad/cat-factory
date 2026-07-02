---
---

docs: improve LLM discoverability of the code structure

Documentation-only change (no versioned package behaviour changes):

- Complete the package map — every workspace package now appears in the root README layout
  tables, `backend/README.md`, and `CLAUDE.md`'s Layout (previously ~9 packages, incl.
  `consensus`, `provider-cloudflare`, `observability-langfuse`, and the `local` runtime, were
  missing from one or more maps).
- Add `scripts/check-package-catalog.mjs` (wired into CI) asserting every package has a
  `description` and a README row, so the map can't drift again.
- Add a co-located `AGENTS.md` to every `backend/packages/*` and `backend/runtimes/*` (public
  entry point + a "where things live" map), plus a root `AGENTS.md` bridging to `CLAUDE.md`.
- Add `docs/glossary.md` (block vs task vs card, the dir↔package name map,
  runner/executor/transport, and where gates / agent kinds / migration parity live).
- Relocate the loose root trackers `modularisation.md` → `docs/` and
  `handover-requirements-review.md` → `docs/handover/requirements-review.md`.
