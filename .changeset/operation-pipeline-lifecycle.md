---
'@cat-factory/example-custom-agent': patch
'@cat-factory/conformance': patch
---

Register a reusable operation's canned pipeline as a read-only versioned catalog template.

An operation bundles a pipeline it PINS by id (`defaultPipelineId`), so how that pipeline is
registered decides whether the org can ever ship a second version of the operation. The worked
example registered `pl_org_introduce_api` versionless, which is the shape with no way out: each
workspace got an editable copy, `reseed` refuses a stored non-builtin, and the advisory's `outdated`
check reads `builtin` off the stored row, so a board could edit or delete the definition out from
under the operation while the org could never roll a fix out to it. It now registers `builtin: true`
with an explicit `version: 1`, which makes it read-only in a workspace (clone to deviate) and puts
it on the reseed lifecycle.

The cross-runtime assertion covers the ADOPTION direction, which nothing did: the existing
`pl_org_flow` test already drives a registered built-in through seed, retire, tombstone and delete.
This one drives a board seeded BEFORE the org ships the operation, as three apps over one store,
because a workspace created after the registration is seeded with the pipeline at creation and so
proves nothing about adoption. It asserts the pipeline is advertised in `pipelineCatalogVersions`
with no stored row (the new-pipeline advisory's state), that one reseed INSERTS it read-only, that
the operation is then invocable with its task pinning the adopted pipeline, and that a version bump
moves the catalog ahead of the stored copy so the same reseed adopts the new definition.

Worth noting for review: the package's other example pipelines (the initiative-preset routing
targets `pl_org_audit` / `pl_org_scope` / `pl_org_research` / `pl_org_apply`) are still versionless
and are deliberately left alone here, since they belong to the initiative-presets examples rather
than to this initiative. The registration-shape rule is now stated once in
`backend/docs/pipeline-catalog-lifecycle.md` so neither doc restates it.
