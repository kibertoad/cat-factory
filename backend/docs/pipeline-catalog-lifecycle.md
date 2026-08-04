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

## Deletion guards

Deleting a pipeline a recurring SCHEDULE points at is refused 409, paused included.
