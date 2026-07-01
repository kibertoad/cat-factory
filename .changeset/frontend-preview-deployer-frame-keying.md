---
'@cat-factory/kernel': minor
'@cat-factory/integrations': minor
'@cat-factory/orchestration': minor
'@cat-factory/contracts': patch
'@cat-factory/worker': patch
'@cat-factory/node-server': patch
'@cat-factory/local-server': patch
---

feat(frontend): key a deployer's ephemeral env by its service FRAME so a live `service` binding
resolves (slice 4b of the frontend-preview + in-context UI-testing initiative,
docs/initiatives/frontend-preview-ui-testing.md).

A `frontend` frame's `service` binding names a service FRAME id, but a `deployer` keyed its
ephemeral env only under the task `block_id` it ran on — so `resolveFrontendConfig`'s
`handle === serviceBlockId` match never hit and a live-service binding fell back to WireMock even
when the backend's env was up (the deferred keying gap slices 3/4 flagged).

The env now also records the resolved service `frame_id` (the deployer's block walked up to its
enclosing frame), and the frontend binding resolution matches handles on THAT. The task-keyed
`block_id` — and the same-block deployer→tester env projection that reads it — is unchanged; this
is an additive column, not a re-key.

- **New `frame_id` column** on `environments`, mirrored D1 (`0030_environment_frame_id.sql`) ⇄
  Drizzle (`environments.frame_id` + generated migration), threaded through `EnvironmentRecord`,
  the `EnvironmentHandle` wire shape, and both registry repos.
- **Keying**: `RunDispatcher.deployerProvisionArgs` resolves the service frame id via the shared
  frame walk and passes it on `ProvisionArgs.frameId`; the provisioning service persists it on both
  the provisioned and the failed-record paths.
- **Resolution**: `AgentContextBuilder.resolveFrontendConfig` indexes the single `listHandles` read
  by `handle.frameId` (still one batch read, no per-binding point read), so a `service` binding
  resolves to its live ephemeral URL — and the frontend UI-test infra gate is satisfied instead of
  refusing the run.
- **Conformance**: a new cross-runtime assertion provisions a service frame's env via a `deployer`,
  then a UI-tester run against a frontend bound to that frame STARTS (the mirror of the existing
  no-live-service refusal), pinning both the `frame_id` D1 ⇄ Drizzle round-trip and the
  frame-keyed resolution.
