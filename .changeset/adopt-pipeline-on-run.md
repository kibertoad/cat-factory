---
'@cat-factory/kernel': minor
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

Worth watching in review: the read-only twin, `resolveDefinition`, is not symmetry. It fixes a real
hole. `individualVendorsForBlock` backs the personal-credential gate on the start request and read the
bare row, so an un-adopted pipeline resolved to no agent kinds, the gate concluded the run needed no
personal subscription, and the run then adopted and started ungated. It now asks the same question
adoption would answer, without writing. The other thing to check is the wiring:
`ExecutionServiceDependencies.pipelineRegistry` is optional, so a facade that forgets it typechecks and
the built-in half of adoption still works, leaving only a deployment's own registered pipelines
unadoptable. The composition root reads `runtime.pipelineRegistry`, never an injected argument, so the
engine and `PipelineService` adopt from one instance.

Left refusing on purpose: an initiative policy edit or a recurring schedule naming an un-adopted
pipeline. Both are authoring paths where the SPA only offers stored pipelines, so the refusal is
reachable headlessly only, and adopting on an authoring write would materialise rows for pipelines
nobody ran.
