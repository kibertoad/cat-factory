---
"@cat-factory/kernel": minor
"@cat-factory/contracts": minor
"@cat-factory/integrations": minor
"@cat-factory/orchestration": minor
"@cat-factory/server": minor
"@cat-factory/worker": minor
"@cat-factory/node-server": minor
"@cat-factory/local-server": minor
"@cat-factory/app": minor
---

Observability for ephemeral-environment and container provisioning.

- **Unified provisioning event log.** A new append-only log records every attempt to
  spin up / tear down throwaway infrastructure — ephemeral environments
  (provision/teardown/status) and the runner-pool / per-run containers
  (dispatch/release/poll-failure) — with the outcome and the verbatim provider/runtime
  error on failure. Surfaced via `GET /workspaces/:ws/provisioning-logs` and a "View
  logs" button in the ephemeral-environment provider and self-hosted runner-pool config
  panels.
- **Env lifecycle in run details.** An agent run's step now carries the ephemeral
  environment it runs against (spinning up / running / shut down / errored + URL/expiry
  + exact error), shown in the step detail (notably for the Tester).
- **Container-start failures.** When a container/runner never accepts the job, the run
  details now say "Container failed to start" and show the exact provider/runtime error
  (a `dispatch`-kind failure) instead of a generic "Run failed".

**Breaking / operational:** the provisioning log lives in a PHYSICALLY SEPARATE store to
isolate its high write churn. The Cloudflare Worker needs a new `PROVISIONING_DB` D1
binding (its own `migrations-provisioning` dir — create the database and apply its
migrations); when absent, the feature is simply off. The Node service uses a dedicated
`provisioning` Postgres schema, created idempotently by `migrate()` on boot (the DB role
needs `CREATE` on the database). Retention is governed by `PROVISIONING_LOG_RETENTION_DAYS`
(default 14). Catching a container dispatch error at the dispatch site means a transient
dispatch blip is now a terminal `dispatch` failure (retry from the failure card) rather
than relying on a Workflows step retry.
