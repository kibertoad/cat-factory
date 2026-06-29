---
'@cat-factory/executor-harness': minor
'@cat-factory/kernel': minor
'@cat-factory/contracts': minor
'@cat-factory/orchestration': minor
'@cat-factory/app': minor
'@cat-factory/server': patch
---

Surface the Tester's in-container docker-compose dependency stand-up logs on the test report
window.

A `local`-infra Tester stands the service's dependencies up inside its container with
`docker compose up --wait` before running. Until now that command's output was written only
to the harness's own logs — so when the dependencies failed to come up (a port clash, an
image pull-auth failure, a healthcheck timeout, a service that exits immediately) the run
showed an opaque failure and the single highest-signal artifact for diagnosing it was
unreachable from the UI. This was flagged as the natural follow-up to the container-lifecycle
observability work (the orchestrator-side provisioning logs can't see it — the stand-up runs
_inside_ the container).

- **Harness.** `standUpInfra` now captures the `docker compose up` stdout+stderr (on success
  _and_ failure), redacts credentials (the shared `redact` now also scrubs credential-named
  `KEY=value` / `KEY: value` assignments — e.g. a dependency echoing `POSTGRES_PASSWORD=…` —
  which are neither a token shape nor a known value), tail-bounds it, and returns an
  `infraSetup` record
  (started / compose path / duration / logs / error) on the agent result.
- **Propagation.** The record rides the existing `RunnerJobResult` → `AgentRunResult` path
  (forwarded verbatim by both transports) and the engine persists it on the Tester step as
  `step.test.infraSetup`, refreshed on each Tester round.
- **UI.** The test report window's Infrastructure section now shows a "Dependency stand-up"
  panel — the outcome, the compose file, how long it took, the verbatim error on failure, and
  the captured stand-up logs behind a toggle.
- **Parity.** The cross-runtime conformance suite asserts the record round-trips onto
  `step.test.infraSetup` identically on D1 and Postgres.

Bumps the `@cat-factory/executor-harness` image to `1.26.0` (the harness `src/` changed) and
the matching tag in `deploy/backend`.
