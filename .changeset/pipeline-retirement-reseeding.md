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
  `retiredPipelines()`), and `seedPipelines()` now excludes anything retired — so a withdrawn
  pipeline is no longer seeded into new workspaces, no longer carries a catalog version, and is no
  longer reseedable, with no change at any existing call site. Retiring a built-in is two edits:
  delete its definition from the builder AND name its id in the tombstone list.
- `PipelineRegistry` gains `retire(id, { replacedBy })` / `retired()` / `mergeRetired()`, so a
  deployment can withdraw its OWN registered pipelines. `register` and `retire` are inverses for an
  id, and a live catalog entry always wins, so the live and retired sets stay disjoint.
- `PipelineService.remove` accepts a built-in only while it is retired (a pipeline the catalog still
  ships stays read-only), and the workspace snapshot ships `retiredPipelines` beside
  `pipelineCatalogVersions`.
- The SPA's pipeline-health advisory grows a "Retired pipelines" section offering a per-row removal,
  naming the replacement when the catalog declares one. A retired pipeline is excluded from every
  reseed offer, including the "new built-ins available" list.

Also fixes an adjacent gap: deleting a pipeline that a recurring schedule still points at is now
refused with a 409 naming the fix, for custom pipelines as much as retired built-ins. Previously the
delete succeeded and every subsequent fire of that schedule failed silently.
