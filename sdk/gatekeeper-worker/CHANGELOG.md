# @cat-factory/gatekeeper-worker

## 0.4.0

### Minor Changes

- 11f9efa: Public API (`/api/v1`, spec 1.32.0): the two cost and telemetry reads that were reachable only
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

### Patch Changes

- Updated dependencies [11f9efa]
  - @cat-factory/sdk@0.26.0
  - @cat-factory/gatekeeper-bindings@0.7.0

## 0.3.1

### Patch Changes

- Updated dependencies [3e9a6af]
  - @cat-factory/sdk@0.25.0
  - @cat-factory/gatekeeper-bindings@0.6.0

## 0.3.0

### Minor Changes

- e1e868d: Answer `GET /health` from the whole configuration, not the two bindings the request path happens
  to read

  The documentation sweep on this package claimed `/health` reported "whether the configuration and
  policy compile". It did not. The route returned `{ ok: true }` after assembling a `Gatekeeper`,
  and assembly reads exactly `CAT_FACTORY_BASE_URL`, `PROVISIONING_KEY` and the `STATE` namespace.
  A deployment that never set `WEBHOOK_SECRET`, `OS_SHARED_TOKEN`, `PUBLIC_URL` or `WEBHOOK_ID`
  answered 200 there while `/rpc` refused every call with a 503 and the receiver verified no
  delivery. That is the one answer a health route must never give: a monitor keyed on it agrees the
  deployment is fine.

  The fix was to make the code true rather than to narrow the sentence. `/health` now runs before
  the assembly, checks every binding in one pass, and is green only when the policy also compiles.
  The check is derived from `GatekeeperEnv` through an exhaustive `Record`, so a binding added to
  the interface fails to compile until it says how it is supplied: a binding this check silently
  passed over is a binding whose absence reads as a healthy Gatekeeper.

  One pass rather than the first name the path tripped on, because the operator this serves is
  wiring a deployment: naming one unset binding per redeploy fixes a half-wired Worker one restart
  at a time. Each name now carries the mechanism it actually takes, which the old refusal left
  ambiguous ("set it in wrangler.toml (a var) or with `wrangler secret put` (a credential)") and
  which both READMEs had got wrong in the same direction, telling operators that the secrets live
  in `wrangler.toml`. `wrangler secret put PROVISIONING_KEY` is the whole difference between an
  admin API key in a secret store and one in a git history, so the vars/secrets split is now stated
  once in code and cited by the docs rather than restated by each.

  Behaviour change to watch for: an existing monitor pointed at `/health` on a deployment that was
  never fully wired flips from green to a 503 naming what is unset. That is the report, not a
  regression.

## 0.2.0

### Minor Changes

- ca2a8e3: First release of the Cloudflare OS Gatekeeper machinery as an installable library: the Cap'n Web
  capability surface compiled from `@cat-factory/gatekeeper-bindings`, per-actor API-key minting, the
  verified outbound-webhook receiver and the approval inbox that answers every park a run stops on.

  A deployment supplies only its policy, through `createGatekeeperWorker({ policy })`, and gets the
  policy vocabulary from the runtime-free `@cat-factory/gatekeeper-worker/policy` entry point.
  `deploy/gatekeeper` is the template that installs it; it was previously a copy of all of the above.

  `@cloudflare/workers-types` is a required peer dependency: every type this package publishes is
  stated in terms of the Worker globals, so a consumer without them cannot compile against it.
