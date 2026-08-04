---
'@cat-factory/kernel': minor
'@cat-factory/observability-otel': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': minor
'@cat-factory/node-server': minor
'@cat-factory/worker': minor
'@cat-factory/conformance': patch
---

Adopt a catalog pipeline into the workspace on first run, so no board is stuck behind an advisory.

Built-in pipelines are copied into each workspace at creation, so a board seeded before a pipeline
shipped holds no row for it, and the catalog's own copy is invisible to every read: the library lists
rows, the builder edits rows, a run resolves by row. For a human browsing the pipeline library the
new-pipeline advisory plus a reseed closes that gap. For anything that PINS a pipeline by id it does
not, and a reusable operation does exactly that: the pin resolves off the task-type registry, which
knows nothing about rows, so a task of the operation was creatable on an older board and then refused
to start with a bare 404 that named nothing the user could act on.

Run resolution now goes through `pipelineAdoption.adoptForRun`, which returns the stored row or
materialises the catalog entry and returns that. It WRITES rather than running off the code copy on
purpose: resolving from the catalog without persisting would leave a run executing a pipeline the
board's own library cannot show, open in the builder, or attach a schedule to, which is the same
dishonesty as rendering an absent thing as an empty one. Only `builtin` catalog entries are adoptable,
and that restriction is the safety argument rather than a convenience: a built-in is read-only and
becomes deletable only once retired, and a retired id is absent from `seedPipelines` by construction,
so "no row plus a live built-in entry" can only mean never adopted. A versionless registered pipeline
is deletable, so adopting one would resurrect a deliberate deletion.

Two adoptions race by construction (two tasks of one operation started at once both resolve "no row"),
so this adds `PipelineRepository.insertIfAbsent`, conflict-targeted `DO NOTHING` on the composite key
on both runtimes. Deliberately not `INSERT OR IGNORE` on D1, which would also swallow an unrelated
constraint failure on that runtime alone and so hide a real bug behind a passing Postgres suite. Both
writers write the same catalog definition, so first write wins and the loser has nothing to report.
`PipelineService.reseed`'s absent branch moved onto the same method, fixing a pre-existing race of its
own, and both now build the row through one shared `adoptedCatalogRow` so adopting and reseeding cannot
diverge on labels or archive state.

Widening what a start resolves means every GATE standing in front of one had to be widened with it,
which is where the read-only twin `resolveDefinition` earns its place. Each of these read the bare row
and, finding nothing, did not refuse but CONCLUDED, about a pipeline that was about to run anyway:

- `individualVendorsForBlock` backs the personal-credential gate on the start request, so an un-adopted
  pipeline resolved to no agent kinds, the gate concluded the run needed no personal subscription, and
  the run then adopted and started ungated.
- The public API's decide-scope check resolves the caller's `pipelineId` to inspect it for parks. A
  `null` skipped the check entirely, and `start` then adopted and parked the run, so a `write`-only key
  could set in motion exactly the park that scope exists to withhold. Both public start paths now read
  `PipelineService.resolveForRun`, which replaces the `get` that served the stored row (nothing wants
  that read any more). One public-API behaviour change falls out of it, additive: naming a pipeline the
  board has not adopted starts the run (or is refused for want of `decide`) instead of answering `404`
  / `pipeline_not_public`, so an integration pinning a pipeline by id no longer waits on a human to
  reseed the board.
- The post-merge auto-start resolved dependents from the workspace's pipeline LIST and dropped any
  whose pin had no row, silently, so a merge propagated into a task that never began. It now resolves
  misses through `adoptableCatalog()` (no point read per miss: the list already proves there is no
  row), and a dependent whose pin resolves to nothing at all is reported rather than dropped.

So a bare `pipelineRepository.get` on a run-adjacent path is now the smell. Adoption is also COUNTED,
through the new `pipeline.adopted` operational counter: the log line says which board caught up, and
only the rate says how many are still behind a catalog the deployment already shipped.

Left refusing on purpose: an initiative policy edit or a recurring schedule naming an un-adopted
pipeline. Both are authoring paths where the SPA only offers stored pipelines, so the refusal is
reachable headlessly only, and adopting on an authoring write would materialise rows for pipelines
nobody ran.
