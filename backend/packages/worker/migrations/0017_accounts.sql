-- Multi-tenant accounts. Until now a workspace was owned by a single GitHub user
-- (migration 0016) and a GitHub App installation was bound exclusively to one
-- workspace (migration 0004) — so a team of engineers could not share boards, and
-- one GitHub account could not back several boards. This migration introduces an
-- account tenancy layer:
--
--   * an `account` (a personal account-of-one, or an org) owns workspaces;
--   * `memberships` map GitHub users to accounts with a role, so many engineers
--     can see and use the same org's workspaces;
--   * a GitHub App installation is bound to an account, so every workspace in that
--     account can link the account's repos (repos are still linked *explicitly*
--     per workspace via the github_repos projection).
--
-- The columns are additive and nullable so the migration is safe and so the
-- auth-disabled / local-dev path (account_id NULL, no signed-in user) behaves
-- exactly as before: no scoping is enforced and every board stays visible.

CREATE TABLE accounts (
  id                   TEXT    NOT NULL PRIMARY KEY,
  type                 TEXT    NOT NULL,            -- 'personal' | 'org'
  name                 TEXT    NOT NULL,
  github_account_login TEXT,                        -- the GitHub org/user login, when known
  created_at           INTEGER NOT NULL
);

-- One personal account per GitHub login, so ensuring it on sign-in is idempotent.
CREATE UNIQUE INDEX idx_accounts_personal
  ON accounts (github_account_login)
  WHERE type = 'personal';

CREATE TABLE memberships (
  account_id TEXT    NOT NULL,
  user_id    INTEGER NOT NULL,                       -- GitHub user id (stable across renames)
  role       TEXT    NOT NULL DEFAULT 'member',      -- 'owner' | 'member'
  created_at INTEGER NOT NULL,
  PRIMARY KEY (account_id, user_id)
);
CREATE INDEX idx_memberships_user ON memberships (user_id);

-- Workspaces gain an owning account. NULL means "unscoped" (legacy rows and the
-- auth-disabled dev path); a signed-in user only sees workspaces whose account is
-- one they are a member of.
ALTER TABLE workspaces ADD COLUMN account_id TEXT;
CREATE INDEX idx_workspaces_account ON workspaces (account_id);

-- A GitHub App installation is now bound to an account (not a single workspace).
-- The workspace_id column from 0004 is retained as the *connector* workspace (and
-- as the binding key for the auth-disabled path, where account_id is NULL).
ALTER TABLE github_installations ADD COLUMN account_id TEXT;
CREATE INDEX idx_gh_install_account
  ON github_installations (account_id)
  WHERE deleted_at IS NULL;
