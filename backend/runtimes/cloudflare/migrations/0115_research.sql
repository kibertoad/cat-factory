-- Research persistence: the definitions an account publishes (immutable per version), what each
-- research project pins, the findings revisions its tasks write (first write wins), and the
-- findings-storage policy tiers (account, workspace, project).

CREATE TABLE research_definitions (
  account_id    TEXT    NOT NULL,
  key           TEXT    NOT NULL,
  version       INTEGER NOT NULL,
  body          TEXT    NOT NULL,
  content_hash  TEXT    NOT NULL,
  created_at    INTEGER NOT NULL,
  PRIMARY KEY (account_id, key, version)
);

CREATE TABLE research_projects (
  project_id          TEXT    PRIMARY KEY,
  definition_key      TEXT    NOT NULL,
  definition_version  INTEGER NOT NULL,
  definition_hash     TEXT    NOT NULL,
  inputs              TEXT    NOT NULL,
  next_seq            INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE findings_revisions (
  id                  TEXT    PRIMARY KEY,
  project_id          TEXT    NOT NULL,
  task_id             TEXT    NOT NULL,
  seq                 INTEGER NOT NULL,
  mode                TEXT    NOT NULL,
  definition_key      TEXT    NOT NULL,
  definition_version  INTEGER NOT NULL,
  created_at          INTEGER NOT NULL,
  body_inline         TEXT,
  body_artifact_id    TEXT,
  body_bytes          INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_findings_revisions_seq ON findings_revisions (project_id, seq);

CREATE TABLE findings_storage_policies (
  owner_kind  TEXT NOT NULL,
  owner_id    TEXT NOT NULL,
  policy      TEXT NOT NULL,
  PRIMARY KEY (owner_kind, owner_id)
);
