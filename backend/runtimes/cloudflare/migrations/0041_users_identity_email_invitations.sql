-- Canonical user identity (decoupled from GitHub) + per-account email senders and
-- invitations. Everything else now keys off `users.id` (a generated `usr_*`), which
-- SQLite's type affinity lets the existing INTEGER user-id columns
-- (memberships.user_id, blocks.created_by, workspaces.owner_user_id,
-- personal_subscriptions.user_id, subscription_activations.user_id) store as text
-- without a column rebuild — so no data-preserving column migration is needed here.
--
-- Backwards compatibility is a non-goal (CLAUDE.md): personal accounts are re-keyed
-- from the GitHub login to the owning user id, so any pre-existing personal-account
-- rows (which have a null owner_user_id) simply stop matching findPersonalByUser and a
-- fresh personal account is created on next sign-in. That is acceptable.

-- Canonical users.
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  name TEXT,
  email TEXT,
  avatar_url TEXT,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_users_email ON users (email) WHERE email IS NOT NULL;

-- Linked login identities (github / password / google). (provider, subject) unique.
CREATE TABLE user_identities (
  user_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  subject TEXT NOT NULL,
  secret TEXT,
  metadata TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (provider, subject)
);
CREATE INDEX idx_user_identities_user ON user_identities (user_id);

-- Re-key personal accounts by the owning user id (not the GitHub login).
ALTER TABLE accounts ADD COLUMN owner_user_id TEXT;
DROP INDEX IF EXISTS idx_accounts_personal;
CREATE UNIQUE INDEX idx_accounts_personal
  ON accounts (owner_user_id)
  WHERE type = 'personal';

-- Optional board description.
ALTER TABLE workspaces ADD COLUMN description TEXT;

-- Per-account email-sender connection (sealed provider API key; UI-onboarded).
CREATE TABLE email_connections (
  account_id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  from_address TEXT NOT NULL,
  api_key_cipher TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);

-- Email invitations into an org account (only the token hash is stored).
CREATE TABLE account_invitations (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  email TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',
  token_hash TEXT NOT NULL,
  invited_by TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_account_invitations_account ON account_invitations (account_id);
CREATE UNIQUE INDEX idx_account_invitations_token ON account_invitations (token_hash);
