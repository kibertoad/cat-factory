-- On-demand recurring pipelines: a schedule flagged `on_demand` is never auto-fired by the
-- cron sweeper (it runs only via manual run-now), so its block may use an individual-usage
-- subscription model. `listDue` now filters `on_demand = 0` so these are skipped by the sweep.
ALTER TABLE pipeline_schedules ADD COLUMN on_demand INTEGER NOT NULL DEFAULT 0;
