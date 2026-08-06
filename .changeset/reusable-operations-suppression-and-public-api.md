---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': minor
'@cat-factory/workspaces': minor
'@cat-factory/app': minor
'@cat-factory/worker': minor
'@cat-factory/node-server': minor
'@cat-factory/sdk': minor
'@cat-factory/mcp-server': minor
---

Close the last committed gaps in reusable operations: hide one per board, invoke one headlessly.

Five changes, landed together because the last two turned out to depend on each other: the public
task-type catalog has to honour suppression (a type it lists and creation then refuses is worse than
one it omits), and both read the registry through the same projection the board snapshot does.

- **Per-workspace suppression.** An org registers its operations process-wide, so twenty of them
  flood the picker of a team that runs three. A workspace admin (`settings.manage`) now hides the
  ones that board does not use. Tombstones in a new `task_type_suppressions` table (D1 ⇄ Drizzle,
  with conformance), so ABSENCE is the default and a newly registered operation reaches every board
  until somebody hides it: the only direction whose silent failure is a surplus rather than a
  withheld capability. Three readers, and their failure postures differ on purpose: the board
  snapshot and the public catalog are best-effort (a picker must not take a board load down over a
  cosmetic preference), while `BoardService.addTask` PROPAGATES, because it decides whether a row is
  written and hits the same database as the insert. The creation refusal is what makes the hiding
  real: the internal API, the public API, an initiative spawn and a tracker import all reach
  `addTask` without ever seeing a picker. Built-in types stay unsuppressible (they carry hardcoded
  creation affordances). Mothership bucket: `remote`, because the catalog is code and the hide-list
  is data.

- **Public API: discover a form, then fill it.** `/api/v1` could always NAME a task type and fill
  none of it, so a headless caller filed an operation and every agent in the run worked from a blank
  form. `GET /api/v1/task-types` (`read`) serves the built-in types plus this workspace's registered,
  non-suppressed ones with the fields each accepts; `fields` on task creation fills them, landing in
  `taskTypeFields.custom` for a custom type and on the schema-typed top-level keys for a built-in
  one, so existing creation machinery runs unchanged. Additive per ADR 0034: OpenAPI `info.version`
  → 1.18.0, SDKs regenerated. One table (`contracts/src/public-task-types.ts`) backs BOTH directions
  rather than the descriptors-plus-hand-written-OpenAPI-shape the design sketched, so what discovery
  advertises is exactly what creation validates, through the shared `validateDescriptorFields` the
  app's own form runs. Refusal is a 422 with `details.reason: 'task_type_fields_invalid'` carrying
  every problem at once.

- **Descriptor defaults apply at the door, not in the form.** `withDescriptorFieldDefaults` runs
  server-side at both descriptor doors (a custom type's creation bag and an initiative preset's
  inputs) before validate + sanitize. A field that is both `required` and defaulted was accepted
  from the SPA (which had already seeded it) and refused for every other caller, which had no way
  to know it must restate a value the deployment already declared. The SPA now seeds from the same
  shared helper rather than its own copy. Consequence worth naming: because defaults are
  authoritative, a `select` default outside its own options is now a boot ERROR
  (`task_type_field_default_outside_options`) instead of a form that merely opened oddly.

- **The new-pipeline advisory names a pipeline instead of humanising its id.** `pipelineCatalogNames`
  rides beside `pipelineCatalogVersions`, built from the same `seedPipelines()` read so the two
  cannot list different ids. Humanising was fine for shipped built-ins and wrong the moment a
  deployment registered its own: `pl_org_introduce_api` was offered as "org introduce api", on
  exactly the boards that predate an operation and therefore see this advisory.

- **The Go SDK client's accessor list was three groups stale.** `me`, `evidence` and `keys`
  generated services that nothing constructed, so those endpoints were uncallable from Go while
  every drift check passed. All are wired, and `check-sdks.mjs` now fails on a resource group Go's
  hand-written client never constructs. Two emitters had the sibling latent bug: group names are
  camelCase in the surface table and every group was one word until `taskTypes`, so Python now
  snake-cases them (`client.task_types`) and so does the MCP facade, whose tool name and group are
  the strings a HOST allow-lists and a model calls (`task_types_list`, and `task_types` in
  `CAT_FACTORY_MCP_GROUPS`). A NEW resource group, as opposed to a new operation, is what exercises
  those paths.

Breaks, all internal and unreleased: `CoreDependencies` and `BoardServiceDependencies` gain an
optional `taskTypeSuppressionRepository`; `snapshotRegistryProjections` takes an optional workspace
id (absent at workspace-create, which cannot have hidden anything); `PublicTaskCreationDeps` gains
`taskTypeRegistry`; the snapshot gains `suppressedTaskTypes`; the Python SDK's and the MCP
facade's multi-word resource names are now snake_case.
