-- Referential integrity for the user-identity lineage (the account-orphaning incident).
--
-- Previously NOTHING referenced users(id) at the DB level, so a users row could be removed
-- while its identity, personal account, and personal subscription lived on — a dangling
-- identity that the login path then silently forked a fresh (empty) account around. Add
-- ON DELETE RESTRICT foreign keys so a users row can no longer be dropped while any of
-- those still reference it; an unsafe delete now fails loudly instead of orphaning.
--
-- SQLite cannot ALTER a table to add a constraint, so each table is rebuilt via the
-- standard create-new / copy / drop / rename dance and its indexes recreated. The current
-- (post-migration) column shapes are reproduced exactly — including accounts.spend_monthly_limit
-- (added in 0042). personal_subscriptions.user_id is also corrected from INTEGER to TEXT
-- to match the canonical `usr_*` users.id (the Postgres side is already text).

-- user_identities.user_id -> users(id)
CREATE TABLE user_identities_new (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  provider TEXT NOT NULL,
  subject TEXT NOT NULL,
  secret TEXT,
  metadata TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (provider, subject)
);
INSERT INTO user_identities_new (user_id, provider, subject, secret, metadata, created_at)
  SELECT user_id, provider, subject, secret, metadata, created_at FROM user_identities;
DROP TABLE user_identities;
ALTER TABLE user_identities_new RENAME TO user_identities;
CREATE INDEX idx_user_identities_user ON user_identities (user_id);

-- accounts.owner_user_id -> users(id)  (nullable: null for org accounts)
CREATE TABLE accounts_new (
  id                     TEXT    NOT NULL PRIMARY KEY,
  type                   TEXT    NOT NULL,
  name                   TEXT    NOT NULL,
  github_account_login   TEXT,
  created_at             INTEGER NOT NULL,
  default_cloud_provider TEXT,
  owner_user_id          TEXT REFERENCES users(id) ON DELETE RESTRICT,
  spend_monthly_limit    REAL
);
INSERT INTO accounts_new (id, type, name, github_account_login, created_at, default_cloud_provider, owner_user_id, spend_monthly_limit)
  SELECT id, type, name, github_account_login, created_at, default_cloud_provider, owner_user_id, spend_monthly_limit FROM accounts;
DROP TABLE accounts;
ALTER TABLE accounts_new RENAME TO accounts;
CREATE UNIQUE INDEX idx_accounts_personal
  ON accounts (owner_user_id)
  WHERE type = 'personal';

-- personal_subscriptions.user_id -> users(id)  (also INTEGER -> TEXT)
CREATE TABLE personal_subscriptions_new (
  id            TEXT    NOT NULL,
  user_id       TEXT    NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  vendor        TEXT    NOT NULL,
  label         TEXT    NOT NULL,
  token_cipher  TEXT    NOT NULL,
  expires_at    INTEGER,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  last_used_at  INTEGER,
  deleted_at    INTEGER,
  PRIMARY KEY (id)
);
INSERT INTO personal_subscriptions_new (id, user_id, vendor, label, token_cipher, expires_at, created_at, updated_at, last_used_at, deleted_at)
  SELECT id, user_id, vendor, label, token_cipher, expires_at, created_at, updated_at, last_used_at, deleted_at FROM personal_subscriptions;
DROP TABLE personal_subscriptions;
ALTER TABLE personal_subscriptions_new RENAME TO personal_subscriptions;
CREATE UNIQUE INDEX idx_personal_subs_user_vendor
  ON personal_subscriptions (user_id, vendor)
  WHERE deleted_at IS NULL;
CREATE INDEX idx_personal_subs_expiry
  ON personal_subscriptions (expires_at)
  WHERE deleted_at IS NULL;
