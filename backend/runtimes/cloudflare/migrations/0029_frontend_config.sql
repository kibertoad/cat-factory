-- Frontend-frame config (slice 2 of the frontend-preview + in-context UI-testing
-- initiative — see docs/initiatives/frontend-preview-ui-testing.md).
--
-- A `frontend`-type frame carries a serialized FrontendConfig: how to build, serve,
-- and mock the app for a self-contained UI test (+ an optional browsable preview on
-- local/node), plus its backend bindings (env-var → upstream), which double as the
-- board's frontend→service links. Stored as a JSON object, mirroring `provisioning`.
ALTER TABLE blocks ADD COLUMN frontend_config TEXT;
