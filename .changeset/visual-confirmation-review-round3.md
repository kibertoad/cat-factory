---
'@cat-factory/contracts': patch
'@cat-factory/orchestration': patch
'@cat-factory/server': patch
'@cat-factory/app': patch
---

Third review pass on the Visual Confirmation gate / binary-artifact storage:

- **Frontend build fix.** `VisualConfirmationWindow.vue` still referenced the `capturing`
  phase that round 2 removed from `visualConfirmStepStateSchema` (a TS2353 excess-property
  on `PHASE_LABEL` and a TS2367 no-overlap comparison in `working`), which broke
  `nuxt typecheck`. Dropped both.
- **Reference re-upload now wins.** `VisualConfirmationController.gatherPairs` kept the
  OLDEST reference image per view (`?? ref.id`), so a human re-uploading a corrected
  reference for a view they already populated never saw it. References are now assigned
  last-writer (newest), matching the oldest-first `listByBlock` ordering.
- **Upload buffering is now actually bounded.** The `Content-Length` precheck was
  bypassable by a chunked / header-less body, after which `formData()` buffered the whole
  request into memory before the per-file ceiling ran. Both upload routes (workspace +
  in-container ingest) now wrap the body in `hono/body-limit`, which counts bytes as the
  stream is read, so a missing/spoofed `Content-Length` can't buffer past the ceiling.
- **Per-run screenshot cap holds under concurrency.** The container-ingest cap was a
  check-then-act race; concurrent ingests could each pass it before any row landed. A
  post-insert reconcile now rolls back (deletes) any insert that lands in the overflow
  tail, so the store is bounded to exactly the cap per run without dropping earlier shots.
- **Removed the vestigial `headSha`** from `visualConfirmStepStateSchema` (and its
  `begin()` initializer) — it was always null and never read; round 1 claimed it was
  dropped but it wasn't.
- **Reuse:** the harness ingest route now uses the exported `bearerToken` helper instead
  of a fourth private copy of the `Bearer` parser.
