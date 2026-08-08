---
'@cat-factory/contracts': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': minor
'@cat-factory/sdk': minor
'@cat-factory/mcp-server': minor
'@cat-factory/gatekeeper-bindings': minor
'@cat-factory/gatekeeper-worker': minor
---

Public API (`/api/v1`, spec 1.32.0): the two cost and telemetry reads that were reachable only
from a browser session. Both additive.

`GET /api/v1/usage/spend` groups a board's spend over a window (`24h` / `7d` / `30d` / `90d`) by
one dimension: `repo`, `ticket` and `run` are the cost-attribution axes an organisation budgets
against, and `model` / `agentKind` / `service` / `taskType` slice the same money the other ways.
`GET /api/v1/usage` answers the budget question and structurally cannot answer this one, since the
ledger row it aggregates carries no board shape and its window is the current calendar month. The
long windows are served from the durable `spend_days` rollup, which froze each run's attribution
while the money was being spent, so a quarterly figure does not move when a service is re-pointed
at a new repository. `source` and `rolledUpThrough` say which store answered and how far its sweep
has covered, because a rollup that has never run and a board that spent nothing produce the same
empty breakdown. There is no `workspace` dimension and no account-wide scope: a workspace-scoped
key must never learn a sibling board's spend. `rows` is the heaviest `limit` slices (default 100,
ceiling 500) with `truncated` beside it, because `run` and `ticket` grow with activity rather than
with a catalog; `totals` aggregates the whole window either way, so a capped answer still reports
what the board spent and loses only the identity of the tail.

`GET /api/v1/debug/runs/:runId/llm-export` serves a run's model activity as one self-describing
bundle, the external counterpart of the app's own export button, for a caller assembling the same
picture from the overview plus a walk of the call list. It differs from the app's export in the
half that matters: the rollups are SQL aggregates over every recorded call and do not move with
`limit`, so a bundle budgeted down to a handful of rows still states what the run actually cost,
where the internal export folds its numbers from the rows it holds and stops pricing them once
they are a slice. `truncated` and `order` say that the call rows are a window and which end was
kept, and `available` says whether the deployment retains LLM telemetry at all, since an unwired
sink and a run that made no model calls otherwise produce the same document and this one is
composed to be handed straight to a model.

The SDK emitters gained the notion of a REQUIRED query parameter, which nothing on the surface had
until now: the TypeScript client no longer defaults such a query bag to `{}` (a signature promising
a call the deployment refuses), Python emits it with no default, Go and Java say so on the field
rather than documenting it as optional, and Java withholds both the no-query call overload and the
record's empty `none()` factory for such an operation, offering `Query.of(<required>)` instead.
The MCP and gatekeeper facades refuse a missing required query parameter locally, naming it, the
way a missing path parameter already was: the reference MCP server forwards a host's arguments
without validating them against the tool's own input schema, so nothing else was catching it.

`@cat-factory/gatekeeper-bindings` (breaking, pre-1.0): a binding's `queryParams` is now
`{ name, required }` records rather than bare names, so a credential-holding front-end can refuse
what the deployment would refuse instead of forwarding it to collect a 400. Bindings that read
captured run telemetry carry `telemetrySink`, and the new `TELEMETRY_BINDINGS` export is that list,
derived from the table. It is what a policy should withhold captured model prompts, tool arguments
and command output with: all of it sits inside a `read` key's floor, and the hand-typed deny list
it replaces had already fallen behind the surface, leaving the run LLM export readable by an
oversight tier that denied every sibling read of the same sink. Generation now fails on a `/debug`
operation that is not classified either way.
