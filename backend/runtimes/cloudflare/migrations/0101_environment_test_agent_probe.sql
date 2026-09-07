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

-- The agent's report (JSON): the operations it attempted, what it could not work out, and the
-- platform-computed verdict. NULL in `provision` mode, and in `agent-probe` mode until the probe
-- returns, including on a run that failed before it, where the run's own `error` says why.
ALTER TABLE environment_test_runs ADD COLUMN probe TEXT;
