-- Tester collapse (per-service provision types): the per-task/per-service `local` vs
-- `ephemeral` toggle is gone. A service now declares a `provisioning` config (the JSON
-- `provisioning` column, added in 0024) and the Tester's infra is driven entirely off its
-- provision type, so the legacy block test-config columns and the workspace
-- `delegate_test_env_to_provider` opt-in are dropped. Symmetric with the Drizzle
-- `20260630150445_medical_ikaris` migration. BC is a non-goal — stale values are simply
-- dropped (see docs/initiatives/per-service-provision-types.md, slice 2c).
ALTER TABLE blocks DROP COLUMN test_compose_path;
ALTER TABLE blocks DROP COLUMN no_infra_dependencies;
ALTER TABLE blocks DROP COLUMN default_test_environment;
ALTER TABLE workspace_settings DROP COLUMN delegate_test_env_to_provider;
