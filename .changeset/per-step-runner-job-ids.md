---
'@cat-factory/kernel': minor
'@cat-factory/server': minor
'@cat-factory/integrations': minor
'@cat-factory/orchestration': patch
'@cat-factory/worker': patch
'@cat-factory/node-server': patch
'@cat-factory/local-server': patch
---

Give every pipeline step its own runner job id so sibling steps in one run can't read
back each other's results.

Every container step of a run was dispatched and polled under the bare execution id,
which is ALSO the per-run container's address. The harness keys its per-kind job
registries by that id and `GET /jobs/{id}` checks them in a fixed order, so two steps
that ran close enough together to share the still-warm container collided: a poll for
one step returned another step's finished result. The visible symptom was an
`architect` (`/explore`) step returning the `spec-writer`'s (`/spec`) document verbatim
with no model call of its own — and, latently, `blueprints`/`mocker` reading back the
`coder`'s result.

The fix separates the two conflated identifiers into an explicit `RunnerJobRef`:

- **`runId`** — the run (execution). On backends that share one container across a run
  (the Cloudflare per-run Container, the local Docker container) this addresses that
  container, and `release` reclaims it.
- **`jobId`** — the job itself, now UNIQUE PER STEP (`<executionId>-<agentKind>`). The
  harness registers and polls each step's job by it, so siblings never alias.

`RunnerTransport.dispatch`/`poll`/`release` and `RunnerJobClient` now take the ref;
`AgentJobHandle` carries the `runId` so the poll/stop site can re-address the per-run
container. The Cloudflare and local transports key the container by `runId` (one
container per run, reclaimed as a unit) and read the harness job by the per-step
`jobId`; a self-hosted pool, being per-job, keys on `jobId` (which already kept its
steps distinct). Single-job flows (repo bootstrap/scan) use the same value for both.
The engine reclaims a run by its id and passes the in-flight step's job id so a pool can
cancel exactly it.

Breaking: `RunnerTransport` implementers now receive a `RunnerJobRef` instead of a bare
job-id string. The local container label moves from `cat-factory.jobId` to
`cat-factory.runId`.
