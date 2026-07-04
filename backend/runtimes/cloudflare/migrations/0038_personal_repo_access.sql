-- Personal-PAT repo access + legacy repo→block linkage removal.
--
-- 1. Drop the obsolete `github_repos.block_id` column: the account-owned `Service`
--    (services.frame_block_id → repo_github_id) is now the SOLE repo↔frame linkage
--    `resolveRepoTarget` reads, so the projection carries no repo→block link.
-- 2. Add `linked_via` so a repo linked via a user's personal access token (which the
--    workspace's shared GitHub App can't reach) is distinguished from an App-reachable
--    one — the board redacts a `'user_pat'` frame for members who can't access it.
-- 3. Add the per-user "repos my PAT can reach" projection the redaction checks (fail
--    closed, no live GitHub call on the snapshot path). Mirrors Drizzle `githubUserRepoAccess`.
ALTER TABLE github_repos DROP COLUMN block_id;
ALTER TABLE github_repos ADD COLUMN linked_via TEXT NOT NULL DEFAULT 'app';

CREATE TABLE github_user_repo_access (
  user_id         TEXT    NOT NULL,
  repo_github_id  INTEGER NOT NULL,
  owner           TEXT    NOT NULL,
  name            TEXT    NOT NULL,
  default_branch  TEXT,
  private         INTEGER NOT NULL DEFAULT 0,
  synced_at       INTEGER NOT NULL,
  PRIMARY KEY (user_id, repo_github_id)
);
CREATE INDEX idx_gh_user_repo_access_repo ON github_user_repo_access (repo_github_id);
