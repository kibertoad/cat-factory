-- GitHub integration: local projections of the GitHub data cat-factory reads
-- often, so the UI/agents don't hit the API on every read and aren't blocked by
-- rate limits. Projections are kept fresh by webhook-driven incremental syncs,
-- on-demand resyncs, and a periodic cron reconciliation pass.
--
-- Conventions follow the existing schema (0001/0003): aggregates are scoped by
-- workspace via composite primary keys, timestamps are INTEGER epoch-ms, JSON is
-- stored as TEXT, there are no foreign keys, and rows that disappear upstream are
-- soft-deleted via a `deleted_at` tombstone (so a webhook delete and a later full
-- reconciliation converge without losing audit history).

-- One GitHub App installation per workspace. Also caches the short-lived (~1h)
-- installation access token + its expiry so we don't re-mint on every call; a
-- lost cache is harmless (the token is cheaply re-derivable from the app JWT).
CREATE TABLE github_installations (
  installation_id   INTEGER NOT NULL PRIMARY KEY,
  workspace_id      TEXT    NOT NULL,
  account_login     TEXT    NOT NULL,
  target_type       TEXT    NOT NULL,
  cached_token      TEXT,
  token_expires_at  INTEGER,
  created_at        INTEGER NOT NULL,
  deleted_at        INTEGER
);
-- A workspace connects to at most one *live* installation. Partial so a
-- tombstoned binding doesn't block reconnecting the workspace to a new one.
CREATE UNIQUE INDEX idx_gh_install_workspace
  ON github_installations (workspace_id)
  WHERE deleted_at IS NULL;

CREATE TABLE github_repos (
  workspace_id     TEXT    NOT NULL,
  github_id        INTEGER NOT NULL,
  installation_id  INTEGER NOT NULL,
  owner            TEXT    NOT NULL,
  name             TEXT    NOT NULL,
  default_branch   TEXT,
  private          INTEGER NOT NULL DEFAULT 0,
  block_id         TEXT,                       -- optional link to a board block
  etag             TEXT,
  synced_at        INTEGER NOT NULL,
  deleted_at       INTEGER,
  PRIMARY KEY (workspace_id, github_id)
);
CREATE INDEX idx_gh_repos_install ON github_repos (installation_id);

CREATE TABLE github_branches (
  workspace_id     TEXT    NOT NULL,
  repo_github_id   INTEGER NOT NULL,
  name             TEXT    NOT NULL,
  head_sha         TEXT    NOT NULL,
  protected        INTEGER NOT NULL DEFAULT 0,
  synced_at        INTEGER NOT NULL,
  deleted_at       INTEGER,
  PRIMARY KEY (workspace_id, repo_github_id, name)
);

CREATE TABLE github_pull_requests (
  workspace_id     TEXT    NOT NULL,
  repo_github_id   INTEGER NOT NULL,
  number           INTEGER NOT NULL,
  github_id        INTEGER NOT NULL,
  title            TEXT    NOT NULL,
  state            TEXT    NOT NULL,
  head_ref         TEXT,
  base_ref         TEXT,
  head_sha         TEXT,
  merged           INTEGER NOT NULL DEFAULT 0,
  author           TEXT,
  gh_updated_at    INTEGER,
  synced_at        INTEGER NOT NULL,
  deleted_at       INTEGER,
  PRIMARY KEY (workspace_id, repo_github_id, number)
);
-- Supports the board's "open PRs for this workspace" reads.
CREATE INDEX idx_gh_pr_state ON github_pull_requests (workspace_id, state);

CREATE TABLE github_issues (
  workspace_id     TEXT    NOT NULL,
  repo_github_id   INTEGER NOT NULL,
  number           INTEGER NOT NULL,
  github_id        INTEGER NOT NULL,
  title            TEXT    NOT NULL,
  state            TEXT    NOT NULL,
  author           TEXT,
  labels           TEXT    NOT NULL DEFAULT '[]',
  gh_updated_at    INTEGER,
  synced_at        INTEGER NOT NULL,
  deleted_at       INTEGER,
  PRIMARY KEY (workspace_id, repo_github_id, number)
);

CREATE TABLE github_commits (
  workspace_id     TEXT    NOT NULL,
  repo_github_id   INTEGER NOT NULL,
  sha              TEXT    NOT NULL,
  message          TEXT    NOT NULL,
  author           TEXT,
  authored_at      INTEGER,
  synced_at        INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, repo_github_id, sha)
);

CREATE TABLE github_check_runs (
  workspace_id     TEXT    NOT NULL,
  repo_github_id   INTEGER NOT NULL,
  github_id        INTEGER NOT NULL,
  head_sha         TEXT    NOT NULL,
  name             TEXT    NOT NULL,
  status           TEXT    NOT NULL,
  conclusion       TEXT,
  synced_at        INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, repo_github_id, github_id)
);
-- Supports "what is the CI status for this commit?" gating reads.
CREATE INDEX idx_gh_checks_sha ON github_check_runs (workspace_id, repo_github_id, head_sha);

-- Incremental sync bookkeeping per (repo, entity kind): the ETag for
-- conditional GETs and/or the `since` timestamp for delta listing.
CREATE TABLE github_sync_cursors (
  workspace_id     TEXT    NOT NULL,
  repo_github_id   INTEGER NOT NULL,
  kind             TEXT    NOT NULL,
  etag             TEXT,
  last_synced_at   INTEGER,
  since_iso        TEXT,
  PRIMARY KEY (workspace_id, repo_github_id, kind)
);

-- Rate-limit ledger: one row per observed `x-ratelimit-*` snapshot, imitating
-- the token_usage spend ledger. Lets us track headroom and back off proactively.
CREATE TABLE github_rate_limits (
  id               TEXT    NOT NULL PRIMARY KEY,
  installation_id  INTEGER NOT NULL,
  resource         TEXT    NOT NULL,
  limit_total      INTEGER,
  remaining        INTEGER,
  reset_at         INTEGER,
  observed_at      INTEGER NOT NULL
);
CREATE INDEX idx_gh_ratelimit_observed ON github_rate_limits (observed_at);
