-- Per-service provision type + per-type infra handlers (slice 1, additive).
-- See docs/initiatives/per-service-provision-types.md.
--
-- (1) The service-owned provision type + the resolved engine are recorded on each
--     provisioned environment so run details can show exactly what ran where.
ALTER TABLE environments ADD COLUMN provision_type TEXT;
ALTER TABLE environments ADD COLUMN engine TEXT;

-- (2) Per-USER infra handler overrides (local mode): the per-user layer over a
--     workspace's per-type handlers. `manifest_id` is '' for non-custom types so it sits
--     in the composite primary key cleanly. The local-only behaviour is enforced at the
--     controller mount, not the table (mirrors local_model_endpoints, which exists in
--     both runtimes).
CREATE TABLE environment_user_handlers (
  user_id             TEXT NOT NULL,
  workspace_id        TEXT NOT NULL,
  provision_type      TEXT NOT NULL,        -- kubernetes | docker-compose | custom | infraless
  manifest_id         TEXT NOT NULL DEFAULT '', -- custom manifest id ('' for non-custom)
  engine              TEXT NOT NULL,        -- local-docker | local-k3s | remote-kubernetes | remote-custom
  provider_id         TEXT NOT NULL,
  label               TEXT NOT NULL,
  base_url            TEXT NOT NULL,
  handler_json        TEXT NOT NULL,        -- serialized InfraHandlerConfig (sans secrets)
  accepts_manifest_id TEXT,                 -- for remote-custom: the manifest id it accepts
  secrets_cipher      TEXT NOT NULL,        -- SecretCipher envelope of the secret bundle
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  PRIMARY KEY (user_id, workspace_id, provision_type, manifest_id)
);

-- (3) Workspace-defined custom-manifest-type catalog entries (the UI-editable half of
--     the custom provision-type catalog; the other half comes from registered providers).
CREATE TABLE custom_manifest_types (
  workspace_id       TEXT NOT NULL,
  manifest_id        TEXT NOT NULL,
  label              TEXT NOT NULL,
  accepts_input_hint TEXT,
  description        TEXT,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, manifest_id)
);
