---
'@cat-factory/app': patch
---

refactor(app): route more stores' list mutation through the `useUpsertList` helper

Finish more of the store pattern-factory adoption (refactoring candidate #3): the plain
find-by-key upsert stores `pipelines`, `releaseHealth`, `accounts`, `bootstrap`,
`sharedStacks`, and `github` (composite `repoGithubId:number` key) now insert/replace/remove
through the shared `useUpsertList` composable instead of hand-rolled `findIndex` blocks.
Mechanical dedup with no behaviour change on the loaded path; the only difference is that a
few former replace-only sites (updating an already-loaded row) now insert-if-missing rather
than silently no-op, which is unreachable in practice since the row is always present. The
monotonic/reconcile-guarded stores (`execution`,
`board`, `workspace`, `environmentTest`, `agentRuns`' bootstrap list) are deliberately left
hand-rolled, since the helper's plain upsert would drop the guard that prevents real-time
store clobber.
