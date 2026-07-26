---
'@cat-factory/executor-harness': minor
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/integrations': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': minor
'@cat-factory/worker': minor
'@cat-factory/node-server': minor
'@cat-factory/local-server': minor
'@cat-factory/app': minor
---

Pre-PR validation: configurable check commands run in the container before a PR is opened.

A service frame can now declare validation commands (install / lint / test / build). After the
coder settles, the executor-harness runs them against the checkout **before** opening a pull
request; a failure is handed back to the agent with the captured output and the loop retries
under a per-service attempt budget (default 3). Only a passing checkout opens a PR — an
exhausted budget fails the step with the last captured output and opens nothing, so broken
lint/tests never become public PR churn.

- New per-service config store (`validation_configs`, D1 ⇄ Drizzle) resolved up the frame chain,
  managed via `GET|PUT|DELETE /workspaces/:ws/services/:blockId/validation-checks` and a new
  service-inspector panel.
- The resolved commands ride the job body (no transport-specific wiring), so this works
  identically on the Cloudflare container, a self-hosted runner pool, and local container/native.
- Command output is truncated and secret-scrubbed, surfaced live on the step while the repair
  loop runs and persisted on `PipelineStep.validation` for observability.
- Unconfigured services are unaffected: no commands resolved, no loop, no job-body field.

BREAKING for self-hosted runner pools only: a pool that wants the LIVE repair-loop view should
map the new `validationReportPath` in its response manifest (the terminal result envelope is
forwarded without any manifest change).
