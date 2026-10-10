-- Shared stacks (slice 4 of the stack-recipes-and-shared-stacks initiative — see
-- docs/initiatives/stack-recipes-and-shared-stacks.md).
--
-- A workspace-scoped, long-lived compose stack that runs ONCE per workspace/machine and
-- that per-PR consumer environments attach to over an external Docker network (the
-- acme-shared-services pilot). The recipe-shaped bring-up fields (`compose_files`,
-- `compose_profiles`, `env_files`, `setup_steps`, `health_gate`) mirror the STACK RECIPE
-- vocabulary; `managed_networks` are the networks the stack creates + owns. JSON-shaped
-- columns are stored as text JSON (mirroring `release_health_configs` / `pipelines`).
-- Bring-up is runtime-bound to the local facade (host Docker), but the row + status are
-- fully symmetric across D1 ⇄ Drizzle (asserted by the cross-runtime conformance suite).
CREATE TABLE shared_stacks (
  workspace_id       TEXT    NOT NULL,
  id                 TEXT    NOT NULL,
  name               TEXT    NOT NULL,
  clone_url          TEXT    NOT NULL,
  git_ref            TEXT,
  -- JSON arrays as text.
  compose_files      TEXT    NOT NULL DEFAULT '[]',
  compose_profiles   TEXT    NOT NULL DEFAULT '[]',
  env_files          TEXT    NOT NULL DEFAULT '[]',
  managed_networks   TEXT    NOT NULL DEFAULT '[]',
  setup_steps        TEXT    NOT NULL DEFAULT '[]',
  -- JSON object as text, or NULL for the default `compose-healthy` gate.
  health_gate        TEXT,
  allow_host_commands INTEGER NOT NULL DEFAULT 0,
  -- Lifecycle: 'stopped' | 'starting' | 'running' | 'failed'.
  status             TEXT    NOT NULL DEFAULT 'stopped',
  last_error         TEXT,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, id)
);
