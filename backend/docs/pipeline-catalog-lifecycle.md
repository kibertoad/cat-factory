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

#### A read on the run path asks ADOPTION, never the bare row

`resolveDefinition` is the read-only twin, for a question about a PROSPECTIVE run. It must agree with
`adoptForRun` about what would run and differ only in writing, because every gate standing in front
of a start resolves the pipeline first and then decides. Answer `null` there and the gate does not
refuse, it CONCLUDES, off a pipeline that is about to run anyway:

- the personal-credential gate read "no agent kinds", so a run needing an individual subscription
  started ungated;
- the public API's decide-scope check found nothing to inspect for parks, so a `write`-only key set
  in motion exactly the park that scope withholds (`PipelineService.resolveForRun`, which replaced
  the `get` that served the stored row, is the one read both public start paths take);
- the post-merge auto-start dropped a dependent whose pin had no row, so a merge propagated into a
  task that silently never began (that path holds the workspace's whole list already, so it resolves
  misses through `adoptableCatalog()` rather than a point read per miss).

So a bare `pipelineRepository.get` on a run-adjacent path is the smell. Adoption is also COUNTED,
not only logged (`pipeline.adopted`): the log line says which board caught up, and only the rate says
how many are still behind a catalog the deployment already shipped.

Still refusing on purpose: an initiative policy edit and a recurring schedule naming an un-adopted
pipeline. Both are AUTHORING paths where the SPA only offers stored pipelines, so adopting on them
would materialise rows for pipelines nobody ran.

### The registration SHAPE picks the lifecycle, and only one of the two can be updated

`builtin: true` plus an explicit `version` makes a registered pipeline a read-only catalog template:
seeded into new workspaces, offered to older boards by the new-pipeline advisory, materialised (and
re-adopted after a version bump) by `reseed`, cloned to deviate. Registered VERSIONLESS it is instead
an editable copy each workspace owns, and `reseed` then refuses the stored row ("Only built-in
pipelines can be reseeded"), so a deployment can never roll a fix out to a board that already holds
it. Anything that PINS a pipeline by id wants the first shape: a reusable operation's
`defaultPipelineId` ([`reusable-operations.md`](./reusable-operations.md))
or an initiative preset's `seedPlan` routing both break if a workspace edits or deletes the
definition out from under them.

## Deletion guards

Deleting a pipeline a recurring SCHEDULE points at is refused 409, paused included.

## Authoring rules bind the SAVE door only

`validatePipelineShape` states what is BROKEN (a companion reviewing nothing, a skill step with no
skill), so both the save boundary and the RUN door refuse it. `validatePipelineAuthoring` states what
is INCOMPLETE, and that difference decides where it may stand.

Today it holds one rule, the ENVIRONMENT LIFECYCLE a step list has to spell out: provision
(`deployer`) → consume (a tester / acceptance / human-test step) → reclaim (`disposer`, or a
`deployer` that DECLARES its environment outlives the run). Each of its faults is a real dead end,
and none of them stops a pipeline that already exists from running: a chain with no `disposer`
leaves its environment to the TTL sweep, and one with no `deployer` runs fine against an
`infraless` service. Enforcing them at the run door would therefore refuse runs of stored pipelines
that work today, including every workspace's seeded copy of a built-in that predates the rule. So
`PipelineService.create` / `update` enforce them and `RunAdmission` does not.

Two halves of the rule bind at BOTH doors and it is worth being precise about which. The rule is
one function in contracts (`pipelineEnvironmentProblems`), and the run door reads it too, filtered
to `ENV_CONSUMER_STARVATION_REASONS`: the faults where a step would find no live environment to
read, which is a run that fails whenever it was authored. What the run door adds is the half no
step list can answer, whether the SERVICE it was started against provisions anything at all
(`assertDeployerBeforeConsumer`). What it declines to refuse is the untidy-but-workable rest: a
`deployer` nobody reclaims, a `disposer` with nothing to reclaim.

Read the ORDER, not the presence, in both directions. The rule walks the enabled steps as a state
machine over whether an environment is standing, because a consumer AFTER the `disposer` starves
exactly as one before the `deployer` does, and a presence check sees only the second. It is also
what lets a chain provision twice (`deployer → tester → disposer → deployer → human-test →
disposer`) read as two clean lifecycles rather than a pile of contradictions.

Three consequences worth knowing before adding a second authoring rule:

- **`clone` is deliberately exempt.** A clone composes nothing, and a workspace holding pre-rule
  built-in copies would otherwise be unable to clone them until it reseeded.
- **The catalog must satisfy every authoring rule** (`pipelineShape.test.ts` asserts it), or the
  platform ships presets its own builder refuses to save. That is why every deploying built-in gained
  a terminal `disposer`, and why adding an authoring rule means auditing the catalog with it.
- **The rule itself belongs in `@cat-factory/contracts`** (`pipeline-environment-lifecycle.ts`), so the
  builder's inline hints and the save refusal are the same function rather than two that drift. Tests
  that need a refused shape seed the row directly (`seedLegacyPipeline`), modelling the legacy state.

## Which pipeline a run resolves when nothing named one

There are two defaults, one per `runDefaultScopeFor(intakeOrigin)` (the same scope the risk-policy
default takes: only `ui` is `interactive`), stored as `Pipeline.isDefault` /
`Pipeline.isUnattendedDefault` and written through `organizePipelineSchema` — the one pipeline body a
BUILT-IN accepts, which is what makes a shipped rung promotable at all.

Only the UNATTENDED scope is seeded (`pl_unattended`). The interactive scope ships with NO flagged
row and its resolution is unchanged: the SPA's interface-mode rung (`defaultBuildPipelineId`), then
catalog order. An operator-declared row outranks both. The asymmetry is the decision, not an
omission: the in-app scope already had a working answer, while a headless start naming no pipeline
against a task pinning none was a `pipeline_required` refusal.

Three traps:

- **The resolution ladder consults the CATALOG, and only sometimes.** `defaultPipelineIdForScope`
  reads the stored library first, and falls back to the catalog's own declaration ONLY while the
  workspace has never adopted that rung — the same reasoning as `pipelineAdoption` for a pinned
  pipeline (an existing board would otherwise be stuck behind a reseed advisory). Once the row is in
  the library its flags are the operator's answer INCLUDING the absence of one, because releasing a
  default has to mean something.
- **`null` is a real answer and a caller states it as one.** The public start path keeps its
  documented `pipeline_required` refusal for a workspace that declares no unattended default; nothing
  invents a rung for a headless caller.
- **An archived or internal pipeline may not hold a default** (`pipeline_not_defaultable`). Both are
  withheld from the library, and a default nobody can see in the library they would go to change it in
  is the concealed-setting failure. The check reads the row the request just WROTE, so archiving and
  promoting in one call is refused whichever order the fields arrive in.

Design record: [ADR 0054](./adr/0054-per-scope-pipeline-defaults.md).
