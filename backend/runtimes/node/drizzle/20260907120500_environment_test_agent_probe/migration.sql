-- The AGENT DRY RUN: the ephemeral-environment self-test's second mode, which hands the
-- environment it just provisioned to an agent and asks whether an agent could actually operate
-- the service. Mirror of D1 migration 0101.
--
-- `mode` defaults to `provision`, so every existing row reads as the provisioning self-test it
-- was; `probe_surface` is the dry run's claim (written before the prober is dispatched) and the
-- executor image every later poll and reclaim has to address; `probe` is the agent's report.
ALTER TABLE "environment_test_runs" ADD COLUMN "mode" text DEFAULT 'provision' NOT NULL;--> statement-breakpoint
ALTER TABLE "environment_test_runs" ADD COLUMN "probe_surface" text;--> statement-breakpoint
ALTER TABLE "environment_test_runs" ADD COLUMN "probe" text;
