-- The workspace's DEFAULT test-environment provisioning mechanism: the provision type
-- (and, for `custom`, the pinned manifest id) stamped onto every newly added service frame.
--
-- Both columns are NULLABLE with no default ON PURPOSE. NULL means "the operator has never
-- chosen", which the SPA nags about with a setup banner; an explicit `infraless` is a real
-- decision (services stand up no environment) and silences it. Defaulting the column to
-- 'infraless' would make every existing workspace look like it had already decided.
-- Mirrored by the Node facade's Drizzle migration.
ALTER TABLE workspace_settings ADD COLUMN default_provision_type TEXT;
ALTER TABLE workspace_settings ADD COLUMN default_provision_manifest_id TEXT;
