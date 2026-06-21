-- Slack integration: an additional delivery transport for the existing
-- notification mechanism (it taps the same NotificationChannel seam — no parallel
-- system). Three tables across two scopes:
--
--   * slack_connections    — PER-ACCOUNT: the installed Slack team + the encrypted
--                            bot token. An org installs Slack once; every workspace
--                            in the account shares it. The token is opaque ciphertext
--                            (WebCryptoSecretCipher, `cat-factory:slack`), never
--                            plaintext, never returned on the wire.
--   * slack_settings        — PER-WORKSPACE: notification routing (which types post,
--                            to which channel) + whether to @-mention.
--   * slack_member_mappings — PER-ACCOUNT: opt-in GitHub-user-id → Slack-member-id
--                            map, backing @-mentions.
--
-- The "account id" is the workspace's account when it has one, else the workspace id
-- (the auth-disabled/dev path has no account → Slack degrades to per-workspace).

CREATE TABLE slack_connections (
  account_id     TEXT    NOT NULL,
  team_id        TEXT    NOT NULL,
  team_name      TEXT    NOT NULL,
  team_icon_url  TEXT,
  bot_user_id    TEXT,
  scopes         TEXT,                 -- JSON array of granted OAuth scopes
  token_cipher   TEXT    NOT NULL,     -- AES-256-GCM envelope of the bot token
  created_at     INTEGER NOT NULL,
  deleted_at     INTEGER,
  PRIMARY KEY (account_id)
);

-- Guard against a Slack team being claimed by a second account (live bindings only).
CREATE UNIQUE INDEX idx_slack_conn_team
  ON slack_connections (team_id) WHERE deleted_at IS NULL;

CREATE TABLE slack_settings (
  workspace_id     TEXT    NOT NULL,
  routes           TEXT    NOT NULL DEFAULT '{}',  -- JSON: { [type]: { enabled, channel } }
  mentions_enabled INTEGER NOT NULL DEFAULT 0,     -- 0/1
  updated_at       INTEGER NOT NULL,
  PRIMARY KEY (workspace_id)
);

CREATE TABLE slack_member_mappings (
  account_id  TEXT    NOT NULL,
  entries     TEXT    NOT NULL DEFAULT '[]',       -- JSON: [{ githubUserId, slackUserId }]
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (account_id)
);
