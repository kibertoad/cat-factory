---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/gates': minor
'@cat-factory/orchestration': minor
'@cat-factory/integrations': minor
'@cat-factory/server': minor
'@cat-factory/sdk': minor
'@cat-factory/mcp-server': minor
'@cat-factory/gatekeeper-bindings': minor
---

Public API (`/api/v1`, spec 1.31.0): board provisioning, task relationships, and the evidence a
judging consumer was missing. All additive.

Seven new operations: `GET /api/v1/repos` and `POST /api/v1/services` (create a service, optionally
backed by a repository, so a headless deployment can provision the board it drives),
`POST /api/v1/tasks/:taskId/dependencies` and `.../dependencies/remove` (declare an ordering
instead of racing a batch of related tasks against one repository), and
`GET|POST /api/v1/tasks/:taskId/documents` plus `.../documents/detach` (a task's spec routinely
arrives after the task does). New fields: `autoStartDependents` on the task patch, `dependsOn` and
`autoStartDependents` on the task projection, `output` and `data` on a run step (an inline-only
pipeline's deliverable, previously readable only in the app), `truncated` on a run step,
`linkedElsewhere` on a repo option, and `scope` on a run artifact.

Two rules a consumer of the new fields should read. **`GET /api/v1/tasks/:taskId/events` serves a
run's step deliverables REDUCED**: an SSE frame carries the whole run, so an oversized `output` is
clipped to a preview and an oversized `data` withheld, with `truncated: true` on the step saying so.
The point read (`GET /api/v1/tasks/:taskId/run`) serves both whole and is what to read for a
deliverable. And **`GET /api/v1/repos` distinguishes three states, not two**: `serviceId` names the
service a repository backs ON THIS BOARD, and `linkedElsewhere` marks one already backing a service
homed on another board of the account, which `POST /api/v1/services` refuses
(`reason: repo_service_homed_elsewhere`) rather than answering with a frame id a workspace-scoped
key could not then use.

One population change worth reading before upgrading: `GET /api/v1/runs/:runId/artifacts` now
returns the reference designs attached to the run's TASK alongside the artifacts the run captured,
each row saying which it is. A consumer counting rows to mean "screenshots this run captured" must
filter on `scope: "run"`; one comparing a screenshot against the design it was judged against
finally has both.

BREAKING for a deployment that registers its own polling gate (internal API, not `/api/v1`): a gate
declares `pollExhaustion` on its REGISTRATION rather than on the `GateDefinition` its factory
builds. `HUMAN_WAIT_GATE_KINDS` and `BUILTIN_GATE_KINDS` are removed from
`@cat-factory/contracts` with them. A declaration left on the definition now fails to typecheck
rather than being silently ignored. The payoff is that public-API admission reads every gate's own
declaration, so a deployment's unbounded human-wait gate is no longer admitted for a plain `write`
key and then parked forever with nothing able to name the surface.

See [ADR 0050](https://github.com/kibertoad/cat-factory/blob/main/backend/docs/adr/0050-public-api-headless-completeness.md).
