-- Per-account (deployment-wide) settings, moved out of env vars. One row per account.
-- `config` is non-secret tuning JSON (retention, inline-web-search, enable gates);
-- `secrets_cipher` is ONE sealed JSON blob grouping every integration credential
-- (Slack OAuth app, web-search keys, Langfuse keys), domain tag
-- 'cat-factory:account-settings'; `summary` is non-secret presence JSON for the UI.
-- A missing row means "all defaults". Mirrors the email_connections per-account shape.
CREATE TABLE account_settings (
  account_id     TEXT    NOT NULL PRIMARY KEY,
  config         TEXT    NOT NULL,
  secrets_cipher TEXT,
  summary        TEXT    NOT NULL DEFAULT '{}',
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);
