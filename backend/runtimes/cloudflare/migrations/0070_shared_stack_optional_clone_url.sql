-- Repo-LESS shared stacks (stack-recipes-and-shared-stacks initiative — see
-- docs/initiatives/stack-recipes-and-shared-stacks.md, the programmatic-config slice).
--
-- A shared stack's ordered `-f` compose layers may now be supplied as INLINE documents or as
-- references into ANOTHER repo, not only as paths inside the stack's own clone. A stack made
-- entirely of those has no repo of its own — which is exactly the shape a deployment declares
-- programmatically at boot (`seedSharedStacks`) — so `clone_url` becomes NULLABLE.
--
-- SQLite has no `ALTER COLUMN`, so this is the standard table rebuild: create the relaxed table,
-- copy every row across, drop the old one, rename. No data is lost and nothing is healed — every
-- existing row has a clone URL and keeps it; only the constraint relaxes. `compose_files` is
-- unchanged on the wire: its JSON array now admits `{"kind":"inline"|"repo"|"path", …}` objects
-- beside the plain path strings it already held (pre-1.0 — no dual-read shim, the reader accepts
-- both because a bare path is a first-class shorthand, not a legacy form).
CREATE TABLE shared_stacks_new (
  workspace_id       TEXT    NOT NULL,
  id                 TEXT    NOT NULL,
  name               TEXT    NOT NULL,
  -- NULL ⇒ a repo-less stack: every compose layer is inline or read from another repo.
  clone_url          TEXT,
  git_ref            TEXT,
  compose_files      TEXT    NOT NULL DEFAULT '[]',
  compose_profiles   TEXT    NOT NULL DEFAULT '[]',
  env_files          TEXT    NOT NULL DEFAULT '[]',
  managed_networks   TEXT    NOT NULL DEFAULT '[]',
  setup_steps        TEXT    NOT NULL DEFAULT '[]',
  prerequisites      TEXT    NOT NULL DEFAULT '[]',
  health_gate        TEXT,
  allow_host_commands INTEGER NOT NULL DEFAULT 0,
  status             TEXT    NOT NULL DEFAULT 'stopped',
  last_error         TEXT,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, id)
);

INSERT INTO shared_stacks_new
  (workspace_id, id, name, clone_url, git_ref, compose_files, compose_profiles, env_files,
   managed_networks, setup_steps, prerequisites, health_gate, allow_host_commands, status,
   last_error, created_at, updated_at)
SELECT
  workspace_id, id, name, clone_url, git_ref, compose_files, compose_profiles, env_files,
  managed_networks, setup_steps, prerequisites, health_gate, allow_host_commands, status,
  last_error, created_at, updated_at
FROM shared_stacks;

DROP TABLE shared_stacks;
ALTER TABLE shared_stacks_new RENAME TO shared_stacks;
