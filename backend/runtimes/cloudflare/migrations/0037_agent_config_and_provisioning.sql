-- Task-level agent-contributed config values + service-level infra/provisioning
-- settings, plus an account-level default cloud provider. The old `test_target`
-- column is intentionally left in place (no longer read/written) to avoid a
-- destructive migration; the contributed-config system replaces it.

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
