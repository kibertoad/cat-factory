---
'@cat-factory/kernel': patch
'@cat-factory/contracts': patch
'@cat-factory/server': patch
'@cat-factory/orchestration': patch
'@cat-factory/worker': patch
'@cat-factory/node-server': patch
---

Second review pass on the Visual Confirmation gate / binary-artifact storage — hardening + a
gap-closing follow-up:

- **Retention no longer orphans bytes.** `BinaryArtifactStore.pruneOlderThan` now keeps a
  metadata row whenever its blob delete fails (instead of dropping the row and orphaning the
  bytes forever), so the next sweep retries it; the all-succeeded path still collapses to one
  bulk delete.
- **Upload size guarded before buffering.** Both the workspace upload and the in-container
  ingest endpoints reject a grossly oversized body from `Content-Length` BEFORE reading it into
  memory (`exceedsRequestSizeLimit`), with the exact per-file 16 MiB ceiling still enforced after
  parsing.
- **Per-run screenshot ceiling.** The container ingest route caps a single run at 100 uploaded
  screenshots (`429` past it), so a runaway/compromised container can't fill the blob store.
- **Consistent content-type posture.** The harness ingest now rejects a recognised non-image
  type (`415`) instead of silently storing it mislabelled as PNG, matching the workspace upload
  endpoint; a typeless upload still defaults to PNG.
- **Tighter human-upload scoping.** The workspace artifact endpoint ignores any client-supplied
  `executionId` (reference images are block-scoped and precede any run; run-scoped captures come
  through the token-authed ingest, where the run is derived from the verified token).
- **`created_at` retention index** added on `binary_artifacts` (D1 `0017` + a generated Drizzle
  migration) so the per-workspace prune is an indexed range delete.
- **`pl_visual` flagged experimental** (`labels: ['experimental']`): until UI-tester image
  routing + harness env-passthrough land, the gate runs in manual mode — the label keeps the
  pipeline discoverable without implying automatic screenshot capture.
- Removed the unused `capturing` phase from `visualConfirmStepStateSchema` (the auto re-capture
  loop it anticipated is still deferred), and added a cross-runtime conformance test for the
  gate's request-fix → fixer → re-park → approve loop.

Note (breaking, already in this PR): the `tester` agent kind was renamed to `tester-api` (with a
new browser-driven `tester-ui` sibling). Per the project's pre-1.0 no-backwards-compat policy,
custom pipelines/blocks persisted with the old `tester` kind are not migrated and will need to be
re-pointed at `tester-api`.
