---
'@cat-factory/local-server': minor
'@cat-factory/node-server': minor
'@cat-factory/server': minor
---

Mothership mode: telemetry is now local-first, so a mothership-mode run finally produces the
observability it is supposed to.

Previously the five telemetry repositories resolved to the remote registry, where none of their
methods is (or should be) allow-listed: every write came back `unknown_method` — swallowed by the
best-effort recorders — and every read came back empty, so the observability panel, the per-step
token rollups, the web-search log and the provisioning "View logs" surfaces were blank on a
mothership-mode node with nothing failing anywhere.

A mothership-mode node now writes and reads its per-call LLM metrics, agent-context snapshots,
performed web searches, provisioning log and modeled subscription quota cycles in its own
`node:sqlite` telemetry store (`telemetry.sqlite`, override `LOCAL_MOTHERSHIP_TELEMETRY_DB`), and
prunes it to the deployment's configured retention windows. The bucket is composed into the
repository registry once (`createRemoteRepositoryRegistry`'s new `localFirst` map), so every
consumer resolves it with no per-consumer wiring.

Two boundary changes ride with it:

- `tokenUsageRepository.record` is now remotely callable, under a new `usageRecord` scope rule. The
  spend ledger has the telemetry write profile but is the org's budget safeguard, and the spend gate
  already reads its rollups remotely — a laptop-local ledger would leave local runs invisible to the
  budget they must answer to. The rule pins the row's denormalized `accountId`/`userId` to the
  caller, so a node cannot inflate another account's or teammate's budget.
- `llmCallMetricRepository.summarizeByExecution` is no longer remotely callable: it was a run-path
  stopgap against the mothership's telemetry store, which holds none of a laptop's calls, so it
  could only ever report zeros for the run that produced them.

Batch-ingesting a finished run's telemetry up to the mothership (so hosted teammates can read it,
and it survives the local prune) is the remaining half of this initiative slice.
