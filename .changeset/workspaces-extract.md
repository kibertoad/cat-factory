---
'@cat-factory/workspaces': minor
---

Extract `@cat-factory/workspaces` from `@cat-factory/core`

`WorkspaceService` and `AccountService` (tenancy base services) move to the new
`@cat-factory/workspaces` package. `@cat-factory/core` re-exports the full surface
for backward compatibility — no consumer import paths change.
