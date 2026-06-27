---
'@cat-factory/kernel': patch
'@cat-factory/server': patch
'@cat-factory/agents': patch
'@cat-factory/orchestration': patch
'@cat-factory/provider-s3': patch
'@cat-factory/worker': patch
'@cat-factory/node-server': patch
'@cat-factory/app': patch
---

Review round 4 (visual-confirmation gate / binary artifacts):

- **Don't load the AWS SDK unless S3 is actually used.** `@cat-factory/provider-s3` now imports
  `@aws-sdk/client-s3` lazily (on the first S3 operation) instead of at module load, so a
  Node/local deployment running the `db` (or no) blob backend no longer pays the SDK's load cost
  even though the facade statically imports `S3BinaryBlobBackend` to wire its container.
- **Guard Approve when the gate flags its screenshots as unreliable.** The visual-confirmation
  window now requires an explicit "I've reviewed this manually" acknowledgement before Approve is
  enabled whenever the gate set a `degradedReason` (no capture happened, a fix failed, or a fix
  landed AFTER the shown screenshots) — so a stale/empty gallery can't be approved in one blind
  click.
- **Cheaper per-run upload cap.** The harness screenshot ingest precheck uses an indexed
  `countByExecution` (no row materialise) and only runs the post-insert overflow reconcile when the
  insert could actually cross the cap, so the steady-state upload is one COUNT + one insert.
- **Serve a blob in a single metadata read** via `BinaryArtifactStore.getBlobWithMetadata`.
- **Drop dangling screenshot refs.** The gate validates the agent-reported screenshot `artifactId`s
  against what the run actually uploaded, so a fabricated id or one removed by the retention sweep
  renders as "not captured" rather than a 404 image.
- Make the UI-tester prompt honest: it now only instructs an upload when `ARTIFACT_UPLOAD_URL` is
  provided to the run (manual mode otherwise), and treats the reference-design directory as
  optional.

The new `countByExecution` / `getBlobWithMetadata` store methods are mirrored D1 ⇄ Drizzle and
asserted by the cross-runtime binary-artifacts conformance suite.
