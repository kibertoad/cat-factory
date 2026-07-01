---
'@cat-factory/server': patch
---

mothership: allow-list the advanced review / structured-dialogue session surface

In mothership mode the clarity-review (bug-report triage), brainstorm (structured dialogue) and
consensus (multi-strategy orchestration) session repositories were not fully remotely callable over
`/internal/persistence`, so a mothership-mode SPA could run/re-read the board-load view of a review
but could not persist or replace one as its window iterates (the write/delete methods came back
`unknown_method`). This widens `REMOTE_PERSISTENCE_METHODS` to their full read+write surface,
mirroring the requirements-review surface already exposed — member-level and workspace-scoped (none
of the review endpoints is admin-gated):

- `clarityReviewRepository` — `get` / `upsert` / `deleteByBlock` (`getByBlock` was already exposed).
- `brainstormSessionRepository` — `get` / `upsert` / `deleteByBlockStage` (`getByBlockStage` was
  already exposed).
- `consensusSessionRepository` — `get` / `getByStep` / `getByBlock` / `upsert` (new repo entry).
- `requirementReviewRepository` — `deleteByBlock`, the pre-review-run drop that completes the repo.

Every method takes the workspaceId as arg0 (the `upsert(workspaceId, review)` signature carries it
positionally, so the existing `workspace` rule binds it — resolve the owning account, reject
out-of-scope as 404). These are core repos, so a mothership-mode node already sources them from the
full-surface remote registry — no `pickRepoSource` routing change, just the allow-list. Server-only,
symmetric by construction (the dispatcher reflects over each facade's registry). Round-trip +
cross-account-scope tests cover every new method; the static drift guard moves them out of `pending`.
