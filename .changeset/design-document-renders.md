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
ending up with no images is otherwise the same absence. A deployment with no image storage
configured imports the design textually and says so rather than downloading bytes it cannot keep.

Internal break: `binary_artifacts` rows and `documents` rows written before this change carry no
document keying and no render status. Both self-heal on the next import; nothing needs a backfill.
