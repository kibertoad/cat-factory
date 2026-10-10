-- Repo-sourced Claude Skills library (docs/initiatives/repo-skills.md, slice 1).
-- An account links a repo directory of skill folders (`<skill>/SKILL.md` + sibling
-- resources); the link is synced into the account's skill catalog, shared across the
-- account's workspaces. Mirrors the fragment-library repo-source machinery (ADR 0006)
-- but with ONE tier (the account) and a directory-per-skill sync unit.

CREATE TABLE skill_sources (
  id                 TEXT    NOT NULL PRIMARY KEY,
  account_id         TEXT    NOT NULL,
  repo_owner         TEXT    NOT NULL,
  repo_name          TEXT    NOT NULL,
  git_ref            TEXT    NOT NULL DEFAULT 'HEAD',
  dir_path           TEXT    NOT NULL DEFAULT '',
  -- Head commit sha of the source dir at the last sync; powers the staleness probe.
  last_synced_commit TEXT,
  last_synced_at     INTEGER,
  created_at         INTEGER NOT NULL,
  deleted_at         INTEGER,
  UNIQUE (account_id, repo_owner, repo_name, git_ref, dir_path)
);
-- List by account (management surface).
CREATE INDEX idx_skill_sources_account
  ON skill_sources (account_id) WHERE deleted_at IS NULL;
-- Push-webhook fan-out (slice 4) looks sources up by repo without scanning every row.
CREATE INDEX idx_skill_sources_repo
  ON skill_sources (repo_owner, repo_name) WHERE deleted_at IS NULL;

CREATE TABLE account_skills (
  -- Stable, globally-unique id — `src:<sourceId>:<dirName>`.
  skill_id      TEXT    NOT NULL,
  account_id    TEXT    NOT NULL,
  name          TEXT    NOT NULL,            -- SKILL.md frontmatter `name`
  description   TEXT    NOT NULL,            -- SKILL.md frontmatter `description`
  instructions  TEXT    NOT NULL,            -- SKILL.md markdown body
  resources     TEXT    NOT NULL DEFAULT '[]', -- JSON [{ path, sha, size }] manifest
  source_id     TEXT    NOT NULL,            -- → skill_sources.id
  source_path   TEXT    NOT NULL,            -- SKILL.md path within the source repo
  source_sha    TEXT    NOT NULL,            -- SKILL.md blob sha last synced
  pinned_commit TEXT,                        -- head commit the dir was synced at
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  deleted_at    INTEGER,                     -- tombstone (removed upstream / source unlinked)
  PRIMARY KEY (account_id, skill_id)
);
CREATE INDEX idx_account_skills_account
  ON account_skills (account_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_account_skills_source
  ON account_skills (source_id) WHERE deleted_at IS NULL;
