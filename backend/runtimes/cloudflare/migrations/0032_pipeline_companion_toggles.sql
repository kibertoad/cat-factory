-- Pipeline builder: persist the two per-step companion toggles that were previously
-- carried on the domain entity but dropped at the persistence layer.
--
-- `pipelines.follow_ups`     — JSON array of per-step Follow-up companion toggles, parallel
--                              to agent_kinds. `false` disables the Coder's Follow-up
--                              companion on that step; null/absent ⇒ enabled (the default).
-- `pipelines.tester_quality` — JSON array of per-step test quality-control companion configs,
--                              parallel to agent_kinds. An entry with `enabled: false` turns
--                              the QC companion off on a Tester step; an entry with `gating`
--                              makes the coverage audit conditional on the task estimate;
--                              null/absent ⇒ enabled, ungated (the default).

ALTER TABLE pipelines ADD COLUMN follow_ups TEXT;
ALTER TABLE pipelines ADD COLUMN tester_quality TEXT;
