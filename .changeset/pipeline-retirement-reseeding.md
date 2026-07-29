---
'@cat-factory/kernel': minor
'@cat-factory/contracts': minor
'@cat-factory/orchestration': minor
'@cat-factory/workspaces': minor
'@cat-factory/app': minor
'@cat-factory/conformance': minor
---

Retire built-in pipelines: remove ones that are no longer relevant through the reseed lifecycle

A built-in pipeline is copied into every workspace at creation, so withdrawing one from the catalog
in code did nothing for boards that already had it — `reseed` had no definition left to resolve and
`remove` refused every built-in, leaving an obsolete pipeline in each existing library permanently
(and still startable). Retirement closes that gap.

- Kernel gains a tombstone list (`buildRetiredPipelines` in `domain/seed.ts`, exposed as
  `retiredPipelines()`). Retiring a built-in is TWO edits — delete its definition from the builder
  AND name its id in the tombstone list — and they do different jobs: the deletion is what takes the
  pipeline out of `seedPipelines()` (so it stops being seeded into new workspaces, drops out of the
  catalog versions, and stops being reseedable, with no change at any of its call sites), while the
  tombstone is the separate positive assertion that the id used to be ours and is now obsolete, which
  is what reaches a board that already stored it. Doing only the deletion is the silent no-op this
  release fixes; doing only the tombstone is caught by a kernel unit test and a boot check.
- `PipelineRegistry` gains `retire(id, { replacedBy })` / `retired()` / `mergeRetired()`, so a
  deployment can withdraw its OWN registered pipelines. `register` and `retire` are inverses for an
  id, and a live catalog entry always wins, so the live and retired sets stay disjoint. A deployment
  cannot withdraw a BUILT-IN this way (that would be a route to emptying the curated palette), and
  `validateRegistrations` now raises `retirement_of_live_pipeline` at boot when a `retire()` call
  names a still-live pipeline, rather than leaving the ignored call to be discovered as a cleanup
  that never appeared.
- `PipelineService.remove` accepts a built-in only while it is retired (a pipeline the catalog still
  ships stays read-only), and the workspace snapshot ships `retiredPipelines` beside
  `pipelineCatalogVersions`.
- The SPA's pipeline-health advisory grows a "Retired pipelines" section offering a per-row removal,
  naming the replacement when the catalog declares one — resolved from the stored row when the board
  has one and from the catalog otherwise, since the usual retirement is superseded-by-a-newly-shipped
  built-in, which has no row until someone adds it. A retired pipeline is excluded from every reseed
  offer, including the "new built-ins available" list.

Also fixes an adjacent gap: deleting a pipeline that a recurring schedule still points at is now
refused with a 409 naming the fix, for custom pipelines as much as retired built-ins. Previously the
delete succeeded and every subsequent fire of that schedule failed silently. A paused (`enabled:
false`) schedule blocks the delete too — pausing is not detaching, and the breakage would otherwise
surface when someone re-enabled it. That refusal and the two pre-existing schedule refusals on
`update` now carry machine-readable `details.reason` codes (`pipeline_schedule_attached` /
`pipeline_schedule_requires_recurring` / `pipeline_schedule_intake_unconfigured`), so the SPA words
them in the user's language instead of surfacing the raw English message.
