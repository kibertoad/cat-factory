---
'@cat-factory/node-server': minor
---

Export the Drizzle GitHub projection repositories (`DrizzleRepoProjectionRepository` and the
branch / pull-request / issue / commit / check-run siblings) from the package entry, so a test
harness can wire the GitHub module through `buildNodeContainer`'s `overrides` seam with no real
GitHub App. Used by the e2e backend to fake the GitHub integration ON (connection + repos +
branches served from real Postgres projections).
