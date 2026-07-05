-- Tiered budgets (account / workspace / user). See docs/initiatives/tiered-budgets.md.
--
-- Attribute each metered call to its owning account + initiating user so the
-- account- and user-tier budget rollups are single indexed reads, add the
-- account-tier limit to the accounts row, and create the per-user settings table
-- that carries the user-tier limit.

-- Ledger attribution (denormalized; nullable for legacy/unattributed rows).
ALTER TABLE token_usage ADD COLUMN account_id TEXT;
ALTER TABLE token_usage ADD COLUMN user_id TEXT;
CREATE INDEX idx_token_usage_account ON token_usage (account_id, created_at);
CREATE INDEX idx_token_usage_user ON token_usage (user_id, created_at);

-- Account-tier budget (null = no account-level limit configured).
ALTER TABLE accounts ADD COLUMN spend_monthly_limit REAL;

-- Per-user settings (today: the user-tier budget). PK is the user id.
CREATE TABLE user_settings (
  user_id             TEXT    NOT NULL PRIMARY KEY,
  spend_monthly_limit REAL,
  updated_at          INTEGER NOT NULL
);
