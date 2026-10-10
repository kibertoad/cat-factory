-- The notification manager: which notification types a workspace delivers on which channel
-- (`in_app` / `email`). One row per workspace, mirroring `slack_settings`.
--
-- `matrix` holds a SPARSE map of overrides (`{"<type>": {"email": true}}`), never a full grid:
-- a cell that is absent means "this board never chose", which resolves to the shipped default
-- for that (type, channel). That is what lets a new notification type — or a new channel —
-- arrive on a sensible default instead of reading as a `false` nobody picked, and it is why
-- this is one JSON column rather than a column per pair that a vocabulary change would migrate.

CREATE TABLE notification_settings (
  workspace_id TEXT    NOT NULL,
  matrix       TEXT    NOT NULL DEFAULT '{}',
  updated_at   INTEGER NOT NULL,
  PRIMARY KEY (workspace_id)
);
