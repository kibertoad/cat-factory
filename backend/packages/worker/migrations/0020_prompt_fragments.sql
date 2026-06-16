-- Prompt-fragment library (ADR 0006). Promotes the best-practice fragment
-- catalog from build-static code to a managed, tenant-scoped projection. A
-- resolved catalog for a workspace is the merge of three tiers — the built-in
-- @cat-factory/prompt-fragments collections (never written here), account-owned
-- fragments, and workspace-owned ones — later tiers overriding earlier by the
-- stable fragment id, with a tombstone (deleted_at) suppressing an inherited or
-- removed-upstream fragment.
--
-- Rows are scoped by an (owner_kind, owner_id) pair so the one table backs both
-- tiers, mirroring how the GitHub installation/repo linkage inherits account →
-- workspace. Provenance columns remember the repo source a fragment came from so
-- a resync is a cheap sha comparison. Additive + opt-in: untouched when the
-- PROMPT_LIBRARY_ENABLED gate is off.

CREATE TABLE prompt_fragments (
  fragment_id  TEXT    NOT NULL,            -- stable id (slug, or src:<sourceId>:<path>)
  owner_kind   TEXT    NOT NULL,            -- 'account' | 'workspace'
  owner_id     TEXT    NOT NULL,            -- account id or workspace id
  version      TEXT    NOT NULL,
  title        TEXT    NOT NULL,
  category     TEXT,
  summary      TEXT    NOT NULL,            -- fed to the relevance selector
  body         TEXT    NOT NULL,            -- folded into the system prompt
  applies_to   TEXT,                        -- JSON { blockTypes?, agentKinds? }
  tags         TEXT,                        -- JSON string[]
  source_id    TEXT,                        -- → fragment_sources.id (null = hand-authored)
  source_path  TEXT,                        -- file path within the source repo
  source_sha   TEXT,                        -- blob sha last synced; powers "changed?"
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  deleted_at   INTEGER,                     -- tombstone (suppress / removed upstream)
  PRIMARY KEY (owner_kind, owner_id, fragment_id)
);
CREATE INDEX idx_prompt_fragments_owner
  ON prompt_fragments (owner_kind, owner_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_prompt_fragments_source
  ON prompt_fragments (source_id) WHERE deleted_at IS NULL;

-- A repo directory linked as a source of Markdown guideline files. Linkable at
-- either tier; reads reuse the account's existing GitHub installation. The
-- last-synced digest makes "check for changes" a cheap comparison, not a re-read.
CREATE TABLE fragment_sources (
  id              TEXT    NOT NULL PRIMARY KEY,
  owner_kind      TEXT    NOT NULL,         -- 'account' | 'workspace'
  owner_id        TEXT    NOT NULL,
  repo_owner      TEXT    NOT NULL,         -- GitHub owner/login
  repo_name       TEXT    NOT NULL,
  git_ref         TEXT    NOT NULL DEFAULT 'HEAD',
  dir_path        TEXT    NOT NULL DEFAULT '',
  last_synced_sha TEXT,                     -- tree digest at last successful sync
  last_synced_at  INTEGER,
  created_at      INTEGER NOT NULL,
  deleted_at      INTEGER,
  UNIQUE (owner_kind, owner_id, repo_owner, repo_name, git_ref, dir_path)
);
CREATE INDEX idx_fragment_sources_owner
  ON fragment_sources (owner_kind, owner_id) WHERE deleted_at IS NULL;
