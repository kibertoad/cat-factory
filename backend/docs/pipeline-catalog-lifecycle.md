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
