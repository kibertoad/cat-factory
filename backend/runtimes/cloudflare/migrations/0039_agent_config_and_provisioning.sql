-- Task-level agent-contributed config values + service-level infra/provisioning
-- settings, plus an account-level default cloud provider. The contributed-config
-- system replaces the old `test_target` column, which is dropped below.

-- Task-level: agent config-contribution values (JSON id->value map).
ALTER TABLE blocks ADD COLUMN agent_config TEXT;

-- Service-level (frame): the Tester's local-infra docker-compose path, the
-- "no infra dependencies" flag, the cloud provider and the abstract instance size.
ALTER TABLE blocks ADD COLUMN test_compose_path TEXT;
ALTER TABLE blocks ADD COLUMN no_infra_dependencies INTEGER;
ALTER TABLE blocks ADD COLUMN cloud_provider TEXT;
ALTER TABLE blocks ADD COLUMN instance_size TEXT;

-- Account-level: the default cloud provider new services in the account inherit.
ALTER TABLE accounts ADD COLUMN default_cloud_provider TEXT;

-- Drop the legacy acceptance-test target column: it is fully superseded by the
-- contributed-config map (`agent_config['playwright.e2eTarget']`) and no longer read.
ALTER TABLE blocks DROP COLUMN test_target;
