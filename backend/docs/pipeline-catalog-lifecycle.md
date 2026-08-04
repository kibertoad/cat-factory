# Built-in pipeline catalog lifecycle

Built-ins are COPIED into each workspace at creation (`seedPipelines()`,
`kernel/src/domain/seed.ts`), so code and rows drift. `reseed` inserts a new one and adopts an
updated one (bump its `version`; that increment is the whole drift signal); `remove` deletes a
withdrawn one; all three key off the CATALOG, never the stored row.

## Retiring a built-in is TWO edits, and doing only the first is a silent no-op

Delete the definition AND name it in `buildRetiredPipelines()`. The tombstone is what flips an
existing row from read-only to removable, and it must be a POSITIVE assertion: "absent from the
catalog" also describes a deployment's own pipelines whenever their package isn't wired. Never
add a filter to `seedPipelines()`.

## Deployment-authored pipelines

A deployment retires its own via `PipelineRegistry.retire(id, { replacedBy })`, cannot retire a
built-in, and `replacedBy` is an ID resolved against the stored row AND the catalog, never prose.

### Adoption: a run materialises a catalog built-in the board was never seeded with

A board seeded before a pipeline shipped holds no row for it, and the catalog's copy is invisible to
every read (`PipelineService.list` is `listByWorkspace`, the builder edits rows, a run resolves by
row). For a human browsing the library the advisory plus a reseed closes that. For anything that
PINS a pipeline by id it does not: a reusable operation's task is creatable on an older board (the
pin resolves off the task-type registry, which knows nothing about rows) and would then refuse to
start. So `pipelineAdoption.adoptForRun` (`modules/pipelines/pipelineAdoption.ts`) resolves the run's
pipeline and INSERTS the catalog row when the board lacks it.

Three rules hold it together:

- **It writes rather than running off the catalog copy.** Resolving from code without persisting
  would leave a run using a pipeline the board's own library cannot show, open in the builder, or
  attach a schedule to. Rows stay the single source every surface reads.
- **Only `builtin` catalog entries are adoptable**, and that is the whole safety argument: a built-in
  is read-only and becomes deletable only once RETIRED, and a retired id is absent from
  `seedPipelines` by construction, so "no row plus a live built-in entry" can only mean never
  adopted. A versionless registered pipeline IS deletable, so adopting one would resurrect a
  deliberate deletion.
- **The write is `insertIfAbsent`** (conflict-targeted `DO NOTHING` on `(workspace_id, id)`, not
  `INSERT OR IGNORE`). Two tasks of one operation started at once both resolve "no row" and both
  insert the same definition, so first write wins and the loser has nothing to report. `reseed`'s
  absent branch goes through it too, since it races the same way.

`resolveDefinition` is the read-only twin, for a question about a PROSPECTIVE run (the
personal-credential gate's "which vendors would this need"). It must agree with `adoptForRun` about
what would run and differ only in writing: answering `null` there read as "this pipeline needs no
credential", and the run then started ungated.

### The registration SHAPE picks the lifecycle, and only one of the two can be updated

`builtin: true` plus an explicit `version` makes a registered pipeline a read-only catalog template:
seeded into new workspaces, offered to older boards by the new-pipeline advisory, materialised (and
re-adopted after a version bump) by `reseed`, cloned to deviate. Registered VERSIONLESS it is instead
an editable copy each workspace owns, and `reseed` then refuses the stored row ("Only built-in
pipelines can be reseeded"), so a deployment can never roll a fix out to a board that already holds
it. Anything that PINS a pipeline by id wants the first shape: a reusable operation's
`defaultPipelineId` ([`reusable-operations.md`](../../docs/initiatives/reusable-operations.md) D10)
or an initiative preset's `seedPlan` routing both break if a workspace edits or deletes the
definition out from under them.

## Deletion guards

Deleting a pipeline a recurring SCHEDULE points at is refused 409, paused included.
