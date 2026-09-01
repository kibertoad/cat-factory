-- The workspace's SERVICE CATALOG connection: the developer portal (Backstage today) whose
-- services are imported into the foundational-services catalog as `workspace`-tier rows.
-- See backend/docs/service-catalog-import.md.
--
-- One row per workspace, like `observability_connections`: a workspace either points at a portal
-- or it does not, and a second connection would give the import two estates to reconcile one
-- catalog against.
--
-- The non-secret CONFIGURATION sits in its own columns rather than a JSON summary blob, because
-- every one of these is read on the import path and shown on the management surface: the base URL
-- the request goes to, the scheme the credential is for, the portal-side filter, and the two caps.
-- Only the credential itself is sealed.
CREATE TABLE service_catalog_connections (
  workspace_id      TEXT    NOT NULL,
  -- Which portal product ('backstage'). A column so a second adapter is a value, not a schema.
  provider          TEXT    NOT NULL,
  base_url          TEXT    NOT NULL,
  -- Which auth scheme `credentials` holds a bag for: 'none' | 'static-token' |
  -- 'legacy-shared-secret' | 'oauth2-client-credentials' | 'basic' | 'headers'. NOT inside the
  -- sealed bag: the management read has to say which scheme a connection uses without opening
  -- anything, and 'none' holds no credential to open.
  auth_mode         TEXT    NOT NULL,
  -- Sealed by the facade's SecretCipher (domain tag 'cat-factory:service-catalog'); the empty
  -- string for auth_mode = 'none', which has no secret to seal.
  credentials       TEXT    NOT NULL DEFAULT '',
  -- JSON string[] of portal-side filter terms, ANDed (e.g. ["kind=component"]).
  entity_filter     TEXT    NOT NULL DEFAULT '["kind=component"]',
  include_apis      INTEGER NOT NULL DEFAULT 1,
  max_services      INTEGER NOT NULL DEFAULT 200,
  last_synced_at    INTEGER,
  -- 'ok' | 'partial' | 'failed'; NULL before the first import.
  last_sync_status  TEXT,
  -- What the last import wants a human to know (a truncation, unreadable definitions, a transport
  -- failure). NULL when the pass had nothing to report, which is the only state needing no words.
  last_sync_message TEXT,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  deleted_at        INTEGER,
  PRIMARY KEY (workspace_id)
);

-- The autorefresh sweep drains the stalest live connections in bounded batches, oldest first.
CREATE INDEX idx_service_catalog_stale
  ON service_catalog_connections (last_synced_at)
  WHERE deleted_at IS NULL;
