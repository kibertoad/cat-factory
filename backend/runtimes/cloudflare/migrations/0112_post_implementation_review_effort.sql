-- The post-implementation REVIEW EFFORT, on both risk-policy tiers.
--
-- The `reviewer` companion that grades the Coder's work after implementation always reviewed at one
-- fixed level of thoroughness. A risk policy now states it, so a cautious posture can ask for a
-- broader review that reports less certain findings too, and a lenient one can ask for a quicker
-- pass that reports only what it is sure of.
--
-- `post_implementation_review_effort`: one of `low`, `medium`, `high`, `xhigh`, `max`
--                                      (`REVIEW_EFFORT_LEVELS` in `@cat-factory/contracts`). It is
--                                      guidance the reviewer is handed, not a model or a reasoning
--                                      budget.
--
-- The default is `high`, the level the reviewer ran at before the policy could state one, so every
-- stored policy keeps the behaviour it had and no built-in seed needed a version bump to announce
-- this: a freshly seeded row and a backfilled one are byte-for-byte identical.

ALTER TABLE merge_threshold_presets
  ADD COLUMN post_implementation_review_effort TEXT NOT NULL DEFAULT 'high';

ALTER TABLE account_risk_policies
  ADD COLUMN post_implementation_review_effort TEXT NOT NULL DEFAULT 'high';
