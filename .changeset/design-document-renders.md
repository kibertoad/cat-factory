---
'@cat-factory/kernel': minor
'@cat-factory/contracts': minor
'@cat-factory/integrations': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': minor
'@cat-factory/worker': minor
'@cat-factory/node-server': minor
'@cat-factory/local-server': minor
'@cat-factory/conformance': minor
'@cat-factory/app': minor
---

Retain a design document's rendered frames when it is imported. A Figma import now downloads the
PNGs (the linked frame, or the first six top-level frames of a whole file) and stores them as
`reference` binary artifacts keyed to the document, on the same shelf the visual-confirmation gate
already reads from; a re-import that changes the body replaces the previous set wholesale. The
download is host-pinned to Figma's signed-asset hosts and carries no credential.

Renders ride a new `DocumentSourceProvider.fetchRenders` port rather than `fetchDocument`, and only
run on an import that actually writes a body: a design file's version moves on any edit anywhere in
it, so the dispatch-time freshness ladder re-fetches the text far more often than the pictures
change.

A new `documents.render_status` records what became of them (`stored` / `partial` / `none` /
`failed` / `storage_unavailable`, or null where the question does not apply), because every way of
ending up with no images is otherwise the same absence. It is derived from what was RETAINED, and
counts the frames a provider's own cap excluded as unillustrated, so a six-picture pass over a
twenty-frame file reads as `partial` rather than as a complete design with six screens. A
deployment with no image storage configured imports the design textually and says so rather than
downloading bytes it cannot keep; a settings read that FAILS is `failed`, not
`storage_unavailable`, since telling an operator to configure storage they already have sends them
to fix the wrong thing.

A document's renders are exempt from the age-based artifact retention sweep. Age is the right
lifetime for run debris and the wrong one for a projection of a live row: renders are replaced by
the next import that changes the body and by nothing else, and an unedited design is never
re-imported, so a clock-based sweep would leave the row claiming `stored` over an empty set with
nothing to re-download them.

Internal break: `binary_artifacts` rows and `documents` rows written before this change carry no
document keying and no render status. Both self-heal on the next import; nothing needs a backfill.
`BinaryArtifactMetadataStore.deleteByDocument` is replaced by `deleteByIds`: every id-scoped
reclaim now names the rows whose bytes it has already removed, so a concurrent import's fresh row
cannot be deleted out from under its blob.
