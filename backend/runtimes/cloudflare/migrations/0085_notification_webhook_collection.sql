-- Several NAMED outbound webhooks per workspace, replacing the one-row-per-workspace shape from
-- migration 0061. One endpoint per workspace made a second integration's enrolment a hostile act:
-- registering it overwrote whatever was already there, and the only symptom was that the previous
-- receiver went quiet. Each row now carries a caller-chosen `id` (the key, alongside the workspace)
-- and an operator-facing `name`.
--
-- SQLite cannot re-key a table in place, so this is the standard rebuild. Existing rows migrate to
-- the id `default`, which is exactly what the singular `/api/v1/notification-webhook` routes now
-- address: an already-registered endpoint keeps delivering, and the caller that registered it keeps
-- addressing it through the same route.

CREATE TABLE notification_webhooks_new (
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  types TEXT NOT NULL DEFAULT '[]',
  run_events TEXT NOT NULL DEFAULT '[]',
  alert_events TEXT NOT NULL DEFAULT '[]',
  enabled INTEGER NOT NULL DEFAULT 1,
  secret_sealed TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, id)
);

INSERT INTO notification_webhooks_new
  (workspace_id, id, name, url, types, run_events, alert_events, enabled, secret_sealed, updated_at)
SELECT
  workspace_id, 'default', 'Default', url, types, run_events, alert_events, enabled, secret_sealed, updated_at
FROM notification_webhooks;

DROP TABLE notification_webhooks;

ALTER TABLE notification_webhooks_new RENAME TO notification_webhooks;

-- No extra index on `workspace_id`: it is the leading column of the composite primary key, so the
-- per-workspace list every delivery reads is already served by that index.
