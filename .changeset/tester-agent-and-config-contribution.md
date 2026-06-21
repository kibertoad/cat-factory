---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/agents': minor
'@cat-factory/orchestration': minor
'@cat-factory/integrations': minor
'@cat-factory/server': minor
'@cat-factory/worker': minor
'@cat-factory/node-server': minor
'@cat-factory/local-server': minor
'@cat-factory/app': minor
'@cat-factory/executor-harness': minor
---

Flesh out the Tester agent, add an agent configuration-contribution mechanism, and
make Mocker always precede Tester.

- **Pipelines:** every built-in pipeline that runs a `tester` now runs `mocker`
  immediately before it, so the Tester has its external-dependency mocks up.
- **Config contribution:** agents (built-in or custom, via the agent registry's new
  `configContributions`) declare task-level config parameters. The union over a
  task's pipeline appears on task creation + the inspector and freezes once the
  contributing agent's step starts. Values persist as a sparse `agentConfig` map on
  the block; the catalog rides the workspace snapshot. The Tester contributes its
  `environment` (local vs ephemeral) and Playwright its e2e target (CI vs ephemeral).
  The old fixed `testTarget` block field is dropped (its column is left in place).
- **Tester → Fixer loop:** `tester` is now a container agent that runs the project's
  tests — standing infra up locally via the service's docker-compose (rootless
  Docker-in-Docker in the harness) or against an ephemeral environment — and returns
  a structured report (what was tested, outcomes, concerns, greenlight). On a
  withheld greenlight the engine loops a new dedicated `fixer` agent with the report
  and re-tests, up to the task's merge-preset attempt budget. New harness `/test` +
  `/fix-tests` endpoints; reports + fixer summaries render in the inspector and step
  detail.
- **Service + provisioning config:** a service frame carries the Tester's
  docker-compose path / "no infra dependencies" toggle (a Tester pipeline can't start
  until one is set), plus a cloud provider and abstract instance size that resolve to
  the concrete instance-type id forwarded to the runner (Cloudflare instance type, or
  a self-hosted pool that self-provisions).
- **Account default cloud provider (fully wired):** accounts carry a
  `defaultCloudProvider` new services inherit — persisted on both runtimes, settable
  via `PATCH /accounts/:id` (owner-only) and the account menu, returned on the account
  wire, and pre-filled as the service editor's provider default.
- **Local mode is 100% Docker/Podman:** a new first-class `docker` cloud provider
  represents the local daemon. The local runner backend sizes each per-job container
  from the abstract instance size (`--memory`/`--cpus`) and runs the Tester job
  `--privileged` so it stands its docker-compose infra up with Docker-in-Docker on the
  host daemon — never Cloudflare. A Tester-only pipeline with no PR branch now fails
  cleanly (no fixer to push to) instead of throwing.
- Mirrored across both runtimes (D1 migration ⇄ Drizzle schema + migration).
