# `@cat-factory/contracts` — Valibot wire contracts

The dependency **leaf** (no workspace deps). Valibot schemas shared by the SPA + every backend:
the single source of truth for wire shapes and the domain vocabulary.

**Entry:** `src/index.ts`. `src/routes/` holds the per-route request/response contracts; the
top-level files are the domain contracts.

**Key files:**

- `primitives.ts` — the block **type** / **status** / **level** enums. Note the two "task"
  axes: `frame → module → task → epic` is the block **level**, separate from the block **type**
  (`taskType`). See `docs/glossary.md`.
- `entities.ts` — the `Block` and other entity schemas. The canonical unit of work is a
  **block** (`task` is the tracker-boundary name, `card` the UI/events name — one thing, three
  names; `docs/glossary.md`).
- `events.ts` — the `WorkspaceEvent` union pushed to the SPA; `errors.ts` — the `reason`/`code`
  vocabulary the SPA maps to i18n keys.

**See also:** `docs/glossary.md`, `CLAUDE.md` → "Board / service / repo-linkage model".
