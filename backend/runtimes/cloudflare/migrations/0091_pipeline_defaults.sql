-- Per-scope default PIPELINES, and the confidence floor an unattended run's auto-answered
-- requirements finding must clear.
--
-- ADR 0053 gave a workspace two default RISK POLICIES, one per resolution scope, and closed by
-- naming what it could not fix from a policy row: an attended-heavy pipeline is the wrong default
-- for a run nobody is watching, and "per-scope pipeline defaults will address that separately".
-- This is that.
--
-- `pipelines.is_default`            — the workspace's declared default for a run somebody started
--                                     in the app. NULLABLE with NO default, unlike the
--                                     `merge_threshold_presets` flag of the same name: a pipeline
--                                     scope with no declared row is a REAL state (the SPA's
--                                     interface-mode rung answers, catalog order behind it), so
--                                     there is nothing to backfill and a `NOT NULL DEFAULT 0`
--                                     would make "nobody said" indistinguishable from "somebody
--                                     said no".
-- `pipelines.is_unattended_default` — the same for a run nothing is watching. Seeded on
--                                     `pl_unattended` for a NEW workspace; an existing one adopts
--                                     it through the ordinary reseed offer (the rung is a new
--                                     catalog entry, so it simply appears in the library).
--
-- Both indexes are PARTIAL and UNIQUE: the invariant is "at most one holder per workspace per
-- scope", and the many rows holding neither must not collide. A plain unique index over a nullable
-- column would be the wrong statement even where the engine tolerates repeated NULLs.
--
-- `merge_threshold_presets.min_auto_answer_confidence` — how confident the Requirement Writer must
--                                     report being for an `unattended` run to take its suggestion
--                                     as a review finding's answer instead of parking for a person.
--                                     Read only under `autonomy = 'unattended'`, so the shipped
--                                     floor is the column default: a policy that never reads it is
--                                     unaffected, and one that does should not begin life accepting
--                                     an answer the model never graded.

ALTER TABLE pipelines ADD COLUMN is_default INTEGER;
ALTER TABLE pipelines ADD COLUMN is_unattended_default INTEGER;

CREATE UNIQUE INDEX IF NOT EXISTS idx_pipelines_default
  ON pipelines (workspace_id) WHERE is_default = 1;
CREATE UNIQUE INDEX IF NOT EXISTS idx_pipelines_unattended_default
  ON pipelines (workspace_id) WHERE is_unattended_default = 1;

ALTER TABLE merge_threshold_presets
  ADD COLUMN min_auto_answer_confidence REAL NOT NULL DEFAULT 0.8;
