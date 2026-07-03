-- Private package-registry entries per workspace (npm private orgs, GitHub Packages),
-- so agent containers can resolve private dependencies on checkout. One row per
-- workspace holding a single sealed JSON array of entries (each { id, ecosystem,
-- vendor, scopes, token }) plus a non-secret summary blob for display.
CREATE TABLE package_registry_connections (
  workspace_id TEXT    NOT NULL,
  -- Sealed by the facade's SecretCipher (domain tag 'cat-factory:package-registries').
  entries      TEXT    NOT NULL,
  -- Non-secret display fields: [{"id":…,"ecosystem":"npm","vendor":…,"scopes":…,"tokenTail":…}].
  summary      TEXT    NOT NULL DEFAULT '[]',
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  PRIMARY KEY (workspace_id)
);
