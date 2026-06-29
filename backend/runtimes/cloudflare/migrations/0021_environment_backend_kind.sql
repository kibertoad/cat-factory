-- Add a discriminated backend `kind` to the ephemeral-environment connection, mirroring
-- the runner pool's `kind` (`manifest` = the generic BYO HTTP management API,
-- `kubernetes` = native per-PR namespaces, future `nomad`/…). The `manifest_json` column
-- still holds the stored EnvironmentManifest (a native backend rides its `providerConfig`).
-- Existing rows are the manifest backend, so default to it.
ALTER TABLE environment_connections ADD COLUMN kind TEXT NOT NULL DEFAULT 'manifest';
