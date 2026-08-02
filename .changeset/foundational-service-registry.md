---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/agents': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': minor
'@cat-factory/worker': minor
'@cat-factory/node-server': minor
'@cat-factory/local-server': minor
'@cat-factory/app': minor
---

Foundational services gain a deployment tier, honest operation indexing, and set-level contract
validation.

A deployment can now register its shared-capability estate in CODE, on the app-owned
`FoundationalServiceRegistry` injected like `PipelineRegistry` / `TaskTypeRegistry`. Registrations
resolve as the catalog's lowest-precedence `builtin` tier — no rows, so they are present from a
workspace's first request and cannot drift from the definitions — and are validated at boot against
the same schema and document checks the REST write boundary applies. An account or workspace row of
the same id still wins, and either tier can suppress an inherited service: the suppression
sub-resource is now mounted at BOTH scopes, since an account inherits the deployment tier exactly as
a board inherits its account's.

A contract set is validated as a SET rather than per document: a set declared as a TypeScript
contract format must contain at least one document referencing that library, so the schema modules a
contract imports can be registered as what they are. A `files`-mode repo source does the same for
the modules its link explicitly names; folder and directory scans are unchanged.

Contract MODULE operations are indexed. A `@toad-contracts/core` module is read statically
(`method` + a literal/template `pathResolver`), and what the extractor could not read is reported
through `omittedOperations` rather than passing as a complete list. Where a format is not read at
all, that is now stated instead of rendering as "declares no operations".

The enforced capability tags (`asset-storage`, `generation-context`) moved to
`@cat-factory/contracts` so registrants and the SPA import the same vocabulary, and the write
boundary refuses a tag that misses one by case or separators.

Breaking, and deliberate: the merged catalog read (`GET /workspaces/:ws/foundational-services/resolved`)
no longer carries `ownerKind`, `sourceId`, `sourcePath`, `pinnedCommit`, `createdAt` or `updatedAt` —
a `builtin` entry has none of them, and filling them with placeholders would read as fact. Those
fields remain on the per-tier management read. Existing stored `toad-contract` rows keep their empty
operation index until their next upload or repo sync re-indexes them.
