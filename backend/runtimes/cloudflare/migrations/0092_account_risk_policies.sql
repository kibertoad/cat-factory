-- ACCOUNT-tier risk policies, and the boards that hide one (ADR 0055).
--
-- A board's risk-policy library was per-workspace only: a deployment that wanted one merge posture
-- across an org had to author it once per board and keep every copy in step by hand. These two
-- tables add the tier above it, resolved as `account ⊕ workspace` with the board's own row winning a
-- collision (`mergeRiskPolicyTiers` in kernel owns that precedence for BOTH facades).
--
-- `account_risk_policies` is its own table rather than a re-tiering of `merge_threshold_presets`,
-- because the two tiers have different LIFECYCLES: a board row is seeded from the built-in catalog
-- when the board is created, carries the board's per-scope default claims, and is reclaimed by the
-- board-delete cascade. None of that is true of a shared account row, which outlives every board
-- under it. Re-tiering would also have cost the cascade guarantee: the cascade is driven by
-- `DELETE ... WHERE workspace_id = ?` over one authoritative table list, and a table keyed on
-- `(owner_kind, owner_id)` cannot be in it.
--
-- The columns MIRROR `merge_threshold_presets` field for field, with two deliberate omissions:
-- `is_default` and `is_unattended_default`. Which policy governs a task that pinned none is a
-- per-BOARD question — one account's boards routinely want different postures — so there is no row
-- an account could flag that would be right for all of them. A board that wants an inherited posture
-- as its default clones it and promotes the copy, which leaves a row it owns.
--
-- Every default here matches its `merge_threshold_presets` twin, so an account policy authored
-- through a client that omits a newer field behaves exactly as a board policy would.

CREATE TABLE account_risk_policies (
  account_id      TEXT    NOT NULL,
  id              TEXT    NOT NULL,
  name            TEXT    NOT NULL,
  max_complexity  REAL    NOT NULL,
  max_risk        REAL    NOT NULL,
  max_impact      REAL    NOT NULL,
  ci_max_attempts INTEGER NOT NULL,
  max_requirement_iterations      INTEGER NOT NULL DEFAULT 3,
  max_requirement_concern_allowed TEXT    NOT NULL DEFAULT 'none',
  max_tester_quality_iterations   INTEGER NOT NULL DEFAULT 3,
  release_watch_window_minutes    INTEGER NOT NULL DEFAULT 30,
  release_max_attempts            INTEGER NOT NULL DEFAULT 1,
  human_review_grace_minutes      INTEGER NOT NULL DEFAULT 10,
  judge_min_score                 REAL    NOT NULL DEFAULT 0.7,
  judge_max_bounces               INTEGER NOT NULL DEFAULT 1,
  auto_merge_enabled              INTEGER NOT NULL DEFAULT 1,
  fork_decision                   TEXT,
  class_rules                     TEXT    NOT NULL DEFAULT '{}',
  class_rules_by_role             TEXT    NOT NULL DEFAULT '{}',
  dry_run_roles                   TEXT    NOT NULL DEFAULT '[]',
  submission_classes_by_role      TEXT    NOT NULL DEFAULT '{}',
  -- Nullable and unused by the account tier today: the built-in catalog is copied into BOARDS, so an
  -- account library holds only authored rows and has nothing to reseed. The column is kept so the
  -- two tiers' row shapes stay identical, which is what lets a clone copy field-for-field.
  version                         INTEGER,
  autonomy                        TEXT    NOT NULL DEFAULT 'attended',
  min_auto_answer_confidence      REAL    NOT NULL DEFAULT 0.8,
  created_at      INTEGER NOT NULL,
  PRIMARY KEY (account_id, id)
);

-- One row per policy a BOARD hides from its account, so the policy loses the tier merge and no task
-- on that board can pin it.
--
-- A narrow table rather than a tombstone row in the policy table (the shape the fragment and
-- foundational-service libraries use): their tombstone earns its keep by doing a SECOND job, marking
-- a row removed upstream by a repo sync, and it costs them a rule that a suppression must never win
-- the merge as an empty override. A risk policy has no upstream sync and ~20 NOT NULL numeric
-- columns, so a tombstone here would mean inventing ceilings for a row that exists only to be
-- absent. Un-hiding is then a plain DELETE of a row that asserted one thing.
--
-- No FK to `account_risk_policies`: a suppression outliving the policy it named is a REAL state that
-- the editor reports as "hides nothing" (`describeRiskPolicySuppressions`), and a cascade would
-- silently un-hide a posture if an account withdrew and re-authored a policy under the same id.
-- Workspace-scoped, so it is reclaimed by the board-delete cascade (`WORKSPACE_SCOPED_TABLES`).
CREATE TABLE risk_policy_suppressions (
  workspace_id TEXT    NOT NULL,
  policy_id    TEXT    NOT NULL,
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, policy_id)
);
