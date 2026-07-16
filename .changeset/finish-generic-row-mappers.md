---
'@cat-factory/server': patch
---

refactor(server): finish the generic row-mapper adoption (refactoring candidate #2)

The last two hand-enumerated read mappers in `persistence/mappers.ts` — `rowToWorkspace` and
`rowToPipeline` — now derive from a declared field table instead of a hand-written object
literal, via a small read-only path (`makeRowReader` + the `readScalar` / `readNullable` /
`readJson` / `readOptJson` / `readFlag` / `readOptScalar` builders). Both are read-only in this
module (their repos bind columns positionally on write), so they declare only the READ
direction rather than a full three-way `FieldMapper`. `rowToExecution` stays deliberately
bespoke (its tolerant `detail` JSON envelope isn't a column-per-field shape). Pure refactor,
no behaviour change; the flag / version / availability / optional-JSON read semantics are
pinned by new `test/mappers.spec.ts` cases.
