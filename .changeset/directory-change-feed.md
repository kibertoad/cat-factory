---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/worker': minor
'@cat-factory/node-server': minor
'@cat-factory/local-server': patch
---

Record a per-account directory change feed. Every write to a user, account membership, workspace,
workspace membership or repo projection row now appends a `directory_changes` row naming the entity,
in the same transaction (Postgres) or batch (D1), with a per-account `seq` whose commit order equals
its numeric order. New migrations: D1 `0107_directory_changes.sql` and Drizzle
`20261009141534_directory_changes`. Nothing reads the feed yet; the public directory API and
webhooks follow (backend/docs/adr/0067-directory-sync.md).

The local `linkRepo` helper now writes the repo through `DrizzleRepoProjectionRepository`, so
re-linking a repo keeps its monorepo flag instead of resetting it.
