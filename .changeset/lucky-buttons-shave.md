---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': minor
'@cat-factory/node-server': minor
'@cat-factory/worker': minor
---

Add a read-only remote run-debugging API (`/api/v1/debug/*`) so an agent outside the browser can
diagnose a run: a keyset-paginated run index, a per-run overview (steps, per-sink availability +
counts, SQL-aggregated LLM rollups, precomputed diagnostic signals), and bounded drill-downs into
the run's model calls, agent-context dispatches, performed web searches and provisioning event log.

Bodies are opt-in and byte-budgeted, sliced in SQL so an un-previewed page reads no body bytes at
all, and every truncation reports what it left out. The surface needs only a `read`-scope public API
key.

Compatibility break: `ProvisioningLogQuery.before` (a bare `createdAt` keyset) is replaced by a
composite `cursor: { createdAt, id }`, and the matching `?before=` query param is removed from
`GET /workspaces/:ws/provisioning-logs` (the SPA never sent it). The old form dropped rows sharing
a millisecond between pages, which is the common case for a log written in bursts.
