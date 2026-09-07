-- The AGENT DRY RUN: the ephemeral-environment self-test's second mode, which hands the
-- environment it just provisioned to an agent and asks whether an agent could actually operate
-- the service. Mirror of D1 migration 0101.
--
-- `mode` defaults to `provision`, so every existing row reads as the provisioning self-test it
-- was; `probe_surface` is the dry run's claim (written before the prober is dispatched) and the
-- executor image every later poll and reclaim has to address; `probe_dispatched_at` is written
-- AFTER the dispatch, so a durable replay can tell a claim with no job behind it from a running
-- one rather than reading a never-started container as an eviction; `probe_progress` carries the
-- prober's live todo counts through the one stage of this run measured in minutes; `probe` is the
-- agent's report.
ALTER TABLE "environment_test_runs" ADD COLUMN "mode" text DEFAULT 'provision' NOT NULL;--> statement-breakpoint
ALTER TABLE "environment_test_runs" ADD COLUMN "probe_surface" text;--> statement-breakpoint
ALTER TABLE "environment_test_runs" ADD COLUMN "probe_dispatched_at" bigint;--> statement-breakpoint
ALTER TABLE "environment_test_runs" ADD COLUMN "probe_progress" text;--> statement-breakpoint
ALTER TABLE "environment_test_runs" ADD COLUMN "probe" text;
