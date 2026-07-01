-- Environment service-frame keying (slice 4b of the frontend-preview + in-context
-- UI-testing initiative — see docs/initiatives/frontend-preview-ui-testing.md).
--
-- A deployer keys its ephemeral env under the task `block_id` it ran on. A cross-frame
-- consumer — a `frontend` frame's `service` binding — resolves the live env by the bound
-- service FRAME id, which the task block id never matches. Record the resolved service
-- frame alongside the block so `resolveFrontendConfig` can index handles by frame. The
-- task-keyed `block_id` (and the same-block deployer→tester projection) is unchanged.
ALTER TABLE environments ADD COLUMN frame_id TEXT;
