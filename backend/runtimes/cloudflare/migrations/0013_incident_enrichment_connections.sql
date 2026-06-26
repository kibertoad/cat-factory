-- Per-workspace incident-enrichment connection (PagerDuty + incident.io). Moved out
-- of the deployment-wide env vars (PAGERDUTY_API_TOKEN / PAGERDUTY_FROM_EMAIL /
-- INCIDENTIO_API_KEY) onto a sealed per-workspace row. Both vendors live in ONE sealed
-- `credentials` blob; `summary` is the non-secret presence map for the UI. Mirrors the
-- observability_connections shape (migration 0007).
CREATE TABLE incident_enrichment_connections (
  workspace_id TEXT    NOT NULL PRIMARY KEY,
  credentials  TEXT    NOT NULL,              -- sealed JSON { pagerDuty?, incidentIo? }
  summary      TEXT    NOT NULL DEFAULT '{}', -- non-secret presence JSON
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
