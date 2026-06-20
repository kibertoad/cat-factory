-- Deduplicate GitHub sync effort within an org. Incremental-sync cursors were keyed by
-- (workspace_id, repo_github_id, kind), so when two workspaces in the same account both
-- tracked a repo, each kept its own ETag/`since` cursor and each reconcile pass fetched the
-- repo from GitHub independently — N API round-trips for one repo per org.
--
-- Re-key the cursors to (installation_id, repo_github_id, kind): a repo is now fetched once
-- per org and the result fanned out to every workspace that links it (see GitHubSyncService).
-- Cursor rows are pure sync bookkeeping (no user data), so the table is simply rebuilt.

DROP TABLE IF EXISTS github_sync_cursors;

CREATE TABLE github_sync_cursors (
  installation_id  INTEGER NOT NULL,
  repo_github_id   INTEGER NOT NULL,
  kind             TEXT    NOT NULL,
  etag             TEXT,
  last_synced_at   INTEGER,
  since_iso        TEXT,
  PRIMARY KEY (installation_id, repo_github_id, kind)
);
