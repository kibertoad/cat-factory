---
'@cat-factory/server': patch
---

Refactor the shared block row<->domain mappers to a field-map-driven factory.

`rowToBlock` / `blockInsertValues` / `blockPatchToColumns` were three hand-enumerated
functions kept in sync by eye — a new persisted column meant 3–4 coordinated edits and a
renamed column only surfaced at runtime. They now derive all three directions from a single
`blockFields` table (one `FieldMapper` per column, with `scalarField` / `optField` /
`optJsonField` / `optBoolIntField` builders that default the column to the snake_case of the
property). The genuinely divergent columns (the `position`/`size` composites, the tri-state
`technical`, and `serviceFragmentIds`/`agentConfig` whose insert vs patch emptiness rules
differ) stay spelled out inline. Behaviour is unchanged — the existing mapper test suite is
preserved and extended to cover the tri-state, length-clear, and insert-only columns.
