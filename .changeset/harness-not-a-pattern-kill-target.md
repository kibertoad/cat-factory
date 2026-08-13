---
'@cat-factory/executor-harness': minor
'@cat-factory/kernel': minor
'@cat-factory/contracts': minor
'@cat-factory/orchestration': minor
'@cat-factory/integrations': minor
'@cat-factory/observability-otel': minor
'@cat-factory/server': minor
'@cat-factory/local-server': minor
'@cat-factory/worker': minor
'@cat-factory/app': minor
'@cat-factory/sdk': minor
'@cat-factory/mcp-server': minor
'@cat-factory/gatekeeper-bindings': minor
'@cat-factory/acceptance': patch
---

Stop an agent's own cleanup command from killing the harness that supervises it, and report a
harness that WAS stopped as what it is.

A local acceptance run failed as "the container kept vanishing, treating as deterministic" after
two full coder passes. Nothing evicted anything. The harness ran as PID 1 with the command line
`node dist/server.js`, which is also where the Fastify service the coder was scaffolding built to;
the agent started that service in the background to smoke-test it over a real socket, then ran
`pkill -f 'node dist/server.js'` to stop it again. The image ships no `pkill`, so that failed with
`command not found` and the next turn used something that works without procps, which matched PID 1
and shut the harness down. The container exited 0, the engine could only see a backend that had
stopped answering, so it called it an eviction, spent its crash-recovery budget re-running the same
agent into the same wall, and blamed infrastructure churn.

**The harness no longer answers to a pattern kill aimed at anything else.** It runs from
`dist/harness-server.js` and sets `process.title = 'cat-factory-harness'`, which on Linux rewrites
both `/proc/<pid>/cmdline` and (truncated) `/proc/<pid>/comm`, so neither `pkill -f 'node dist/…'`
nor a bare `pkill node` nor a hand-rolled `/proc` sweep can name it. It is not a security boundary
and is not claimed as one: the agent shares the harness's uid, and separating them needs a PID 1
running as root, which this image deliberately does not have. What it removes is the accident.

**`procps` + `psmisc` are now in the image**, which reads backwards until you look at what the
absence caused: `pkill`/`pgrep`/`ps` are the narrow tools an agent reaches for first, and the
fallback it writes when they are missing is the unbounded one that took the harness down.

**A harness that exits cleanly mid-job is no longer an eviction.** Every transport that can read an
exit code (the local container and native-process legs, the Cloudflare per-run container, and a
Kubernetes runner pod's `state.terminated`) now distinguishes a workload that exited 0 with a job
still in flight from one that crashed or was reclaimed, and reports `harnessShutdown` instead of
`evicted`. The engine fails that run immediately with a new `harness_shutdown` failure kind
(additive to the public failure-kind vocabulary; OpenAPI surface 1.54.0) and a hint that names the
causes worth checking, rather than spending an automatic retry that walks back into whatever
stopped it. A backend that reports no exit code (Apple `container`, a manifest-driven runner pool
whose scheduler exposes only status words) keeps reporting an eviction, because an absent code is
not a zero.

The distinction is only ever drawn where NOTHING else explains the stop. Infrastructure churn is
named and recovers on its own budget, and it stays named even after its attribution window passes:
a rollout drain the harness answered by exiting 0, discovered minutes later by a re-driven poll, is
still that drain rather than a shutdown. The same rule orders the engine's own reading: a killed
job that some branch settles WITHOUT failing the run (a parked PR review's read-only Challenge
Investigator) keeps that settlement, since losing a human's in-flight curation is worse than the
retry this failure kind exists to prevent. `container.harness_shutdown` counts the class, kept out
of `container.evicted` so the eviction rate an operator sizes infrastructure by is not inflated by
deaths no infrastructure change prevents.

**An aborted agent run says who aborted it.** The Claude Code / Codex runner rejected with a
hard-coded "agent run aborted by watchdog" for every abort, including the shutdown handler's, so a
job killed by something else filed its failure against a watchdog that never fired. It now carries
the abort reason the caller supplied, the way the Pi runner already did, and an abort that supplied
none falls back to saying so rather than quoting the platform's own contentless "This operation was
aborted" (a reasonless `abort()` sets an `AbortError` that IS an `Error`, so the fallback was
unreachable).

The image moves to `cat-factory-executor:1.121.0` across the wrangler config, the publish script and
`RECOMMENDED_HARNESS_IMAGE`: the entrypoint rename and `procps` are only in effect once a deployment
runs a tag that contains them.

**The acceptance suite stops blaming the merge threshold for a failed run.** Its "the merge was
HELD" hint fired on "there is a pull request and the status is not done", which is also true of a
run that died three phases before any merge was considered; it is now offered only where nothing
else explains the stop.
