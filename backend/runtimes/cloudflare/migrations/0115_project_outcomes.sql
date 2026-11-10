-- What projects of any kind keep: the definitions an account publishes (immutable per version),
-- the definition each project pins, its outcome sequence, the outcome revisions its work writes
-- (first write wins), and the outcome-storage policy tiers (account, workspace, project).
-- Definition specs and outcome bodies are opaque JSON; the project kind owns their shape.

CREATE TABLE project_definitions (
  account_id    TEXT    NOT NULL,
  kind          TEXT    NOT NULL,
  key           TEXT    NOT NULL,
  version       INTEGER NOT NULL,
  body          TEXT    NOT NULL,
  content_hash  TEXT    NOT NULL,
  created_at    INTEGER NOT NULL,
  PRIMARY KEY (account_id, kind, key, version)
);

CREATE TABLE project_pins (
  project_id          TEXT    PRIMARY KEY,
  definition_key      TEXT    NOT NULL,
  definition_version  INTEGER NOT NULL,
  definition_hash     TEXT    NOT NULL,
  inputs              TEXT    NOT NULL
);

CREATE TABLE project_outcome_seqs (
  project_id  TEXT    PRIMARY KEY,
  next_seq    INTEGER NOT NULL
);

CREATE TABLE project_outcomes (
  id                  TEXT    PRIMARY KEY,
  project_id          TEXT    NOT NULL,
  stream              TEXT    NOT NULL,
  seq                 INTEGER NOT NULL,
  intent              TEXT    NOT NULL,
  schema_version      INTEGER NOT NULL,
  task_id             TEXT,
  definition_key      TEXT,
  definition_version  INTEGER,
  artifact_refs       TEXT    NOT NULL,
  created_at          INTEGER NOT NULL,
  body_inline         TEXT,
  body_artifact_id    TEXT,
  body_bytes          INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_project_outcomes_seq ON project_outcomes (project_id, seq);

CREATE TABLE outcome_storage_policies (
  owner_kind  TEXT NOT NULL,
  owner_id    TEXT NOT NULL,
  policy      TEXT NOT NULL,
  PRIMARY KEY (owner_kind, owner_id)
);
