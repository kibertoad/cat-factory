-- Foundational services (backend/docs/adr/0031-foundational-services.md).
-- A tiered catalog of shared capabilities (file storage, notifications, audit …) that a
-- designed system is expected to CONSUME rather than rebuild. Rows are scoped by an
-- (owner_kind, owner_id) pair — an account id or a workspace id — exactly like the
-- prompt-fragment library, so one table backs both tenancy tiers and a workspace tombstone
-- can suppress an inherited account service.
--
-- Identity and DOCUMENTS are deliberately separate tables. The Architect's catalog read runs
-- on every design dispatch and must never load a contract body (an OpenAPI document routinely
-- runs to hundreds of kilobytes, one per service); only the consumer steps, for only the
-- services the design declared, read `api_contracts.body`. Keeping them apart makes that a
-- property of the schema rather than a discipline every caller has to remember.

CREATE TABLE foundational_services (
  service_id    TEXT    NOT NULL,            -- the slug an Architect names in its design
  owner_kind    TEXT    NOT NULL,            -- 'account' | 'workspace'
  owner_id      TEXT    NOT NULL,
  name          TEXT    NOT NULL,
  summary       TEXT    NOT NULL,            -- one line; the catalog's relevance signal
  description   TEXT    NOT NULL DEFAULT '', -- what it does, when to use it, what it does NOT cover
  capabilities  TEXT    NOT NULL DEFAULT '[]', -- JSON string[] of capability tags
  source_id     TEXT,                        -- → foundational_service_sources.id (repo-sourced)
  source_path   TEXT,
  pinned_commit TEXT,                        -- head commit the service dir was synced at
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  deleted_at    INTEGER,                     -- tombstone (removed upstream / suppressed by tier)
  PRIMARY KEY (owner_kind, owner_id, service_id)
);
CREATE INDEX idx_foundational_services_owner
  ON foundational_services (owner_kind, owner_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_foundational_services_source
  ON foundational_services (source_id) WHERE deleted_at IS NULL;

CREATE TABLE api_contracts (
  owner_kind         TEXT    NOT NULL,
  owner_id           TEXT    NOT NULL,
  service_id         TEXT    NOT NULL,
  contract_id        TEXT    NOT NULL,       -- slug within the service (the file basename)
  format             TEXT    NOT NULL,       -- 'openapi' | 'toad-contract' | 'lokalise-api-contract'
  title              TEXT    NOT NULL,
  body               TEXT    NOT NULL,       -- the document verbatim (never read by the catalog)
  -- Operations indexed ONCE at write time, so the catalog can show an agent what the interface
  -- offers without loading a body. JSON string[]; empty for the TypeScript formats.
  operations         TEXT    NOT NULL DEFAULT '[]',
  omitted_operations INTEGER NOT NULL DEFAULT 0,
  source_path        TEXT,                   -- repo provenance; null for a direct upload
  source_sha         TEXT,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL,
  PRIMARY KEY (owner_kind, owner_id, service_id, contract_id)
);
-- The catalog's manifest read (whole tier, no bodies) and the lazy read (a set of service ids)
-- both ride this index.
CREATE INDEX idx_api_contracts_owner
  ON api_contracts (owner_kind, owner_id, service_id);

CREATE TABLE foundational_service_sources (
  id                 TEXT    NOT NULL PRIMARY KEY,
  owner_kind         TEXT    NOT NULL,
  owner_id           TEXT    NOT NULL,
  repo_owner         TEXT    NOT NULL,
  repo_name          TEXT    NOT NULL,
  git_ref            TEXT    NOT NULL DEFAULT 'HEAD',
  -- 'directory' scans <dir_path>/<service>/; 'files' reads an explicit path list for ONE service.
  mode               TEXT    NOT NULL DEFAULT 'directory',
  -- The scanned subtree ('directory'), or the linked files' deepest common directory ('files').
  -- Either way it is what the single head-commit staleness probe anchors on.
  dir_path           TEXT    NOT NULL DEFAULT '',
  file_paths         TEXT    NOT NULL DEFAULT '[]', -- JSON string[]; 'files' mode only
  service_id         TEXT,                          -- 'files' mode only: the service they describe
  service_name       TEXT,
  service_summary    TEXT,
  last_synced_commit TEXT,
  last_synced_at     INTEGER,
  created_at         INTEGER NOT NULL,
  deleted_at         INTEGER,
  UNIQUE (owner_kind, owner_id, repo_owner, repo_name, git_ref, dir_path)
);
CREATE INDEX idx_foundational_sources_owner
  ON foundational_service_sources (owner_kind, owner_id) WHERE deleted_at IS NULL;
-- The autorefresh sweep drains the oldest-synced live sources in bounded batches.
CREATE INDEX idx_foundational_sources_stale
  ON foundational_service_sources (last_synced_at) WHERE deleted_at IS NULL;
