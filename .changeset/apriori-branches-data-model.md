---
'@cat-factory/contracts': minor
'@cat-factory/orchestration': minor
'@cat-factory/kernel': patch
'@cat-factory/server': patch
'@cat-factory/worker': patch
'@cat-factory/node-server': patch
'@cat-factory/conformance': patch
---

Apriori branches (slice 1): data model + write-boundary + persistence.

A task (`Block`) can now name pre-existing branches of its primary target repo via a new
optional `aprioriBranches` field — an array of `{ name, mode: 'reference' | 'working' }`.
`reference` branches are read-only context; the single optional `working` branch is the one
the run keeps building inside (later slices). See `docs/initiatives/apriori-branches.md`.

- **Contracts**: `aprioriBranchSchema` + `AprioriBranch`, the `aprioriWorkingBranch` /
  `aprioriReferenceBranches` helpers, an `isSafeGitBranchName` git-ref-safety check, the new
  `blockSchema` field, and `aprioriBranches` on `updateBlockSchema` (capped at 20). Re-exported
  from `@cat-factory/kernel`.
- **Persistence**: a shared `apriori_branches` JSON text column mirroring `reference_repos`
  (empty-array-is-NULL) — D1 migration `0048_apriori_branches.sql` ⇄ Drizzle schema column +
  generated migration, picked up by both stores through the shared `blockFields` mapper.
- **Write boundary**: `BoardService.updateBlock` drops the field on non-task blocks and enforces
  the cross-entry invariants via `aprioriBranchesError` — at most one `working` entry, no
  duplicate names, the working entry frozen once a PR exists, and no working entry on a
  multi-repo (`involvedServiceIds`) task.
- **Conformance**: a cross-runtime round-trip asserting the column survives PATCH + snapshot
  read on both stores, clears to absent, and rejects the invalid shapes.
