-- Service-level default test environment: the docker-compose (local) vs ephemeral
-- choice a task under a service is spawned with. A task can still override it via its
-- `tester.environment` agent-config value. NULL ⇒ the built-in `ephemeral` default.
ALTER TABLE blocks ADD COLUMN default_test_environment TEXT;
