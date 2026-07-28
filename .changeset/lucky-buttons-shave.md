---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': minor
'@cat-factory/node-server': minor
'@cat-factory/worker': minor
'@cat-factory/local-server': minor
---

Add a read-only remote run-debugging API (`/api/v1/debug/*`) so an agent outside the browser can
diagnose a run: a keyset-paginated run index, a per-run overview (steps, per-sink availability +
counts, SQL-aggregated LLM rollups, precomputed diagnostic signals), and bounded drill-downs into
the run's model calls, agent-context dispatches, performed web searches and provisioning event log.

Bodies are opt-in and byte-budgeted, sliced in SQL so an un-previewed page reads no body bytes at
all, and every truncation reports what it left out. The surface needs only a `read`-scope public API
key.

Root-causing is server-side work, not client-side paging: the LLM-call list takes a `?contains=`
body search (SQL LIKE/ILIKE, case-insensitive, wildcards literal) whose matched rows report a
per-body `matchOffset`; point reads take `?bodyOffset=` so the middle and tail of a large body are
reachable (every body slice now also states its `offset`); the call point read's `?view=messages`
parses the stored prompt delta into per-message rows with independent budgets; and the overview
gains a `failure_outside_model_calls` signal pointing a failed-run-with-clean-calls investigation
at tool execution, which records no calls of its own.

Spend is attributable, not just countable: every call row carries the `phase` that spent it (the
agent's own edit loop, a pre-PR validation repair round, a reproduction-proof repair round, …) and
its `turnIndex` within that job, and `?phase=` narrows the page in SQL like `?agentKind=` does. So
"the pipeline did work this task never needed" is one request rather than a client-side grouping over
the whole run. The EMPTY phase is a queryable value, not "no filter" — it selects the unattributed
slice (an older harness image, an inline call, the un-phased proxy path), which is otherwise
unreachable; and `turnIndex` stays `null` rather than 0 where the producing channel has no turn
concept, so a proxied call is never faked into "the first turn".

All four bounded reads land in the local `node:sqlite` telemetry store too, so the surface works
unchanged in mothership mode, where telemetry is local-first and these pages never cross the machine
RPC (routing a page over a long run would be exactly the bulk read that bucket exists to forbid).

Compatibility break: `ProvisioningLogQuery.before` (a bare `createdAt` keyset) is replaced by a
composite `cursor: { createdAt, id }`, and the matching `?before=` query param is removed from
`GET /workspaces/:ws/provisioning-logs` (the SPA never sent it). The old form dropped rows sharing
a millisecond between pages, which is the common case for a log written in bursts.
