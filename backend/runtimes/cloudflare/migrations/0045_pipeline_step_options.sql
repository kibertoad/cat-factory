-- Pipeline builder: an EXTENSIBLE per-step options bag, replacing the "one column per
-- per-step parameter" pattern (gates / thresholds / enabled / consensus / gating /
-- follow_ups / tester_quality). New per-step parameters now become fields on this JSON
-- object instead of a fresh column — see docs/initiatives/pipeline-step-options.md for
-- folding the legacy arrays into it.
--
-- `pipelines.step_options` — JSON array of per-step options bags, parallel to agent_kinds.
--                            Each entry is a `StepOptions` object (or null ⇒ defaults).
--                            Today it carries only `autoRecommend` (the requirements-review
--                            auto-recommendation toggle; absent/true ⇒ enabled).

ALTER TABLE pipelines ADD COLUMN step_options TEXT;
