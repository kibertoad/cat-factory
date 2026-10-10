-- Per-workspace suppression of a deployment-registered custom task type (a REUSABLE OPERATION;
-- see backend/docs/reusable-operations.md).
--
-- A deployment registers its operations PROCESS-WIDE, so every board in the org offers every one
-- of them. Twenty operations is a realistic org catalog and a flooded picker for a team that uses
-- three, which is the problem this closes: a workspace admin hides the ones that team does not run.
--
-- A TOMBSTONE table, the foundational-services suppression model: a row means "this workspace does
-- not offer this operation", and restoring hard-DELETEs the row rather than flipping a flag.
-- Absence is therefore the default and no workspace needs seeding: a newly registered operation is
-- offered everywhere until someone says otherwise, which is the only direction that cannot silently
-- withhold a capability.
--
-- Suppression is a per-workspace decision about a code-registered catalog, so the row names the
-- task type by ID and nothing else: there is no name, presentation or field list to keep in step,
-- and a suppressed id whose registration is later withdrawn is simply a row nothing matches.
--
-- Mirrors the Drizzle `task_type_suppressions` table on the Node facade.
CREATE TABLE task_type_suppressions (
  workspace_id TEXT    NOT NULL,
  task_type    TEXT    NOT NULL,
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, task_type)
);

-- The primary key serves both reads: the snapshot/settings prefix scan on workspace_id, and the
-- creation-time point check on (workspace_id, task_type). No secondary index.
