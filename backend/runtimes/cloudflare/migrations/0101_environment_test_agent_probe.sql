-- The AGENT DRY RUN: a second mode of the ephemeral-environment self-test that hands the
-- environment it just provisioned to an agent and asks whether an agent could actually operate
-- the service: what it managed, what it could not work out, and which credentials or endpoints
-- were missing. Mirrored on Node by the Drizzle `environmentTestRuns` table.
--
-- `mode` defaults to `provision`, so every existing row reads as the provisioning self-test it
-- was, and the two modes stay one state machine with one always-cleans-up contract.
ALTER TABLE environment_test_runs ADD COLUMN mode TEXT NOT NULL DEFAULT 'provision';

-- The dry run's CLAIM, and the surface it claimed (`api` / `ui`): one column doing both jobs.
-- Written before the prober container is dispatched, never after, so a durable replay between the
-- two re-attaches to the job instead of starting a second agent against the same environment. It
-- carries the surface because the surface decides which executor image the job runs in, and every
-- later poll and reclaim has to address the container that was actually started.
ALTER TABLE environment_test_runs ADD COLUMN probe_surface TEXT;

-- When the prober's container was accepted, written AFTER the dispatch (the claim above is written
-- before it). The pair is what lets a durable replay tell a claim with no job behind it from a job
-- that is really running: without it, a replay landing between the claim and the dispatch polls a
-- container that was never started and reads the backend's "no such job" as an EVICTION, reporting
-- a lost isolate to the developer as a container failure.
ALTER TABLE environment_test_runs ADD COLUMN probe_dispatched_at INTEGER;

-- The prober's live todo counts while it works (JSON `{completed, inProgress, total}`), so the one
-- stage of this run measured in minutes pushes progress to the SPA instead of sitting frozen.
-- NULL before the container reports any, and again once the report has landed.
ALTER TABLE environment_test_runs ADD COLUMN probe_progress TEXT;

-- The agent's report (JSON): the operations it attempted, what it could not work out, and the
-- platform-computed verdict. NULL in `provision` mode, and in `agent-probe` mode until the probe
-- returns, including on a run that failed before it, where the run's own `error` says why.
ALTER TABLE environment_test_runs ADD COLUMN probe TEXT;
