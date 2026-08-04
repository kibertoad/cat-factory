# Public API (`/api/v1`): setup & usage guide

The key-authenticated HTTP surface an external system builds on: an issue tracker that files and
starts tasks, a CI system that reacts to run outcomes, a bot that answers a parked review, a
dashboard that reads spend. Every route is the external counterpart of a service call the SPA
already makes (same behaviour, same arbitration), projected through deliberately small public
resources (`publicTask`, `publicRun`, `publicPipeline`, …) rather than the raw internal entities.

This is the **how-to and reference**. Its siblings each own a different slice:

- [ADR 0030](./adr/0030-public-api-surface.md): the design record covering why the surface has this
  shape, what was rejected, and the paging/idempotency rules a new endpoint must follow.
- [`docs/openapi.json`](../../docs/openapi.json): the generated OpenAPI 3.1 spec (schema-exact,
  suitable for client codegen). See [Extending the surface](#extending-the-surface) for how it is kept
  current.
- [`debug-api.md`](./debug-api.md): the read-only `/api/v1/debug/*` diagnostic surface (same keys,
  `read` scope), for walking a run's telemetry from outside the browser.
- [`public-api-additions.md`](../../docs/initiatives/public-api-additions.md): the live tracker of
  what the decision surface **cannot** answer yet. Read it before building on parked decisions.
- [`sdk/README.md`](../../sdk/README.md): the **official SDK clients** (TypeScript, Python, Go,
  Java+Kotlin), generated from the spec below. Reach for one before hand-rolling HTTP: see
  [Client SDKs](#client-sdks).

## Setup

### 0. Prerequisites

The public API assembles only where the deployment's `ENCRYPTION_KEY` is set (the key store peppers
its hashes with it). On a deployment without it, every `/api/v1` call answers
`503 { "error": { "code": "unavailable", "message": "Public API is not configured" } }`, and the SPA
hides the token panel entirely.

### 1. Mint a key

In the SPA: **Integrations hub → Development → "API access tokens"**. Pick a label and a scope; the
full token is shown **exactly once**, on creation. Store it immediately, it cannot be recovered
(the server keeps only a one-way peppered `HMAC-SHA256` hash). Rotation = revoke + mint a new one.

Over REST (session-authed, workspace-scoped; this is the one management surface that is _not_ under
`/api/v1`):

| Method / path                                | Permission                    | Result                                    |
| -------------------------------------------- | ----------------------------- | ----------------------------------------- |
| `GET /workspaces/:ws/public-api-keys`        | workspace member (read)       | `{ keys: [...] }` (metadata, no secret)   |
| `POST /workspaces/:ws/public-api-keys`       | `secrets.manage` (admin tier) | `201 { key, secret }` (secret shown once) |
| `DELETE /workspaces/:ws/public-api-keys/:id` | `secrets.manage` (admin tier) | `204`; revoked keys never authenticate    |

Create body: `{ "label": "CI pipeline", "scope": "read" }`. `label` is 1–120 chars; `scope` is
optional and **defaults to `write`**. A workspace holds at most **50** keys (409 past that; revoke
one first). Key metadata carries `createdByUserId`, `createdAt`, `lastUsedAt` (updated at most once
a minute) and `revokedAt`.

A key is bound to **one account + workspace**: every `/api/v1` call it makes acts within that
workspace, and resources in any other workspace are a `404` indistinguishable from ones that never
existed.

### 2. Pick the right scope

Scopes are an ordered, **inclusive** ladder; each rung can do everything below it:

| Scope    | Adds                                                                                                                                                                             |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `read`   | All reads and streams: list services/tasks/pipelines/jobs/notifications, read a run, SSE, `GET /usage`, the whole [`/debug` surface](./debug-api.md).                            |
| `write`  | Non-destructive mutations: create/edit/start/stop/retry a task, start a headless job, cancel a job, dismiss a notification.                                                      |
| `decide` | Answer a run's **parked human decisions** (`/runs/:runId/decisions/*`) and, because of that, start a job OR a board task on a pipeline that can park.                            |
| `admin`  | Destructive / merge-adjacent operations: delete a task, `act` on a notification (which can perform a **real merge**), and manage the [outbound webhook](#outbound-webhook-push). |

Two things to know before minting `decide` or `admin`:

- **`decide` is workspace-wide, not limited to runs the key started.** The decision surface resolves
  any run in the key's workspace, including a board task a human started in the SPA. That is the
  point (a headless overseer watching a team's board), but it means minting `decide` is the operator
  asserting "this integration answers decisions for this workspace". Prefer `write` for an
  integration that only authors and launches.
- Handing out even a `read` key is not free once the debug surface is in play: it reaches prompt
  and response bodies the SPA gates behind workspace RBAC. See the
  [auth section of `debug-api.md`](./debug-api.md#auth).

### 3. Authenticate

Present the token on every request:

```sh
curl -s -H "Authorization: Bearer cf_live_pak_…" \
  "https://<your-backend-origin>/api/v1/services"
```

The base URL is your **backend** origin (the Worker or Node service, e.g. what the SPA was built
with as `NUXT_PUBLIC_API_BASE`), not the frontend's. The token format is
`cf_live_<keyId>.<secret>`; treat it as opaque. Auth failures:

| Condition                                    | Response                                                                                                                                   |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Missing / malformed / unknown / revoked key  | `401` `{ "error": { "code": "unauthorized", "message": "Invalid or missing API key" } }`                                                   |
| Key scope below the route's minimum          | `403` `{ "error": { "code": "insufficient_scope", "message": "This action requires a '<need>'-scope key; this key is scoped '<have>'" } }` |
| Public API not configured on this deployment | `503` `{ "error": { "code": "unavailable", … } }`                                                                                          |

## Conventions

### The error envelope

Every failure is `{ "error": { "code", "message", "details"?, "issues"? } }`. `code` is
machine-readable; `message` is operator prose. Codes fall in two families:

- **Status-class codes** (thrown domain errors): `validation` (400 for a malformed request body /
  query, 422 for a domain rule), `not_found` 404, `conflict` 409, `unauthorized` 401, `forbidden`
  403, `credential_required` 428, `rate_limited` 429, `unavailable` 503, `internal` 500. A 400
  validation failure carries `issues: [{ path, message }]`.
- **Surface-specific codes**, unique to `/api/v1` (branch on these, not on the message):

  | Code                             | Status  | Where                                                                                                         |
  | -------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------- |
  | `insufficient_scope`             | 403     | any route, when the key's scope is below the minimum                                                          |
  | `invalid_cursor`                 | 400     | any paginated list, on a malformed `cursor`                                                                   |
  | `pipeline_not_public`            | 400     | `POST /jobs`: unknown or non-public pipeline                                                                  |
  | `pipeline_not_inline`            | 400     | `POST /jobs`: pipeline has container/GitHub steps                                                             |
  | `pipeline_requires_decide_scope` | 403     | `POST /jobs` and `POST /tasks/:id/start`: pipeline can park on a human, key is below `decide`                 |
  | `too_many_active_runs`           | 429     | `POST /jobs`: the workspace already has 5 headless jobs in flight                                             |
  | `pipeline_required`              | 400     | `POST /tasks/:id/start`: no pinned pipeline and no `pipelineId` passed                                        |
  | `service_archived`               | 409     | `POST /tasks/:id/start`: the enclosing service is archived                                                    |
  | `individual_model_unsupported`   | 409     | start / retry / notification `act` that would run an individual-usage (personal-credential) model headlessly  |
  | `no_run`                         | 404/409 | task run reads (404: never started) and stop/retry (409: nothing to act on)                                   |
  | `no_review`                      | 404     | an iterative-review decision route (requirements / clarity / brainstorm): the run carries no such live entity |
  | `notification_not_actionable`    | 409     | `POST /notifications/:id/act` on a card with no automated headless action                                     |

### Pagination

Bounded lists (`GET /jobs`, `GET /services/:id/tasks`, and everything under `/debug`) are
**keyset**-paginated:

- `?limit=`: 1..100, digits only (defaults: jobs 25, tasks 50). Anything else is a 400.
- `?cursor=`: opaque; echo a previous page's `nextCursor` back verbatim. A tampered or truncated
  cursor is `400 invalid_cursor`, never a silent reset to page one.
- `nextCursor: null` means last page. Non-null means "there may be more": page until null; the next
  page may legitimately be empty.

Keyset means a poll loop never sees a row skipped or repeated because of concurrent inserts.
Ordering caveats: the **jobs** list is newest-first and takes `?status=` (coarse public status) and
`?since=` (epoch ms, created-at-or-after) filters; the **task** list is ordered by stable task id,
deterministic and safe to page, but **not** chronological, and it has no `since` (see ADR 0030 for
why).

### Runs park indefinitely: plan the exits

A run parked on a human decision waits **forever**; there is no timeout to design against. If your
integration starts runs that can park, it must either answer them (a `decide` key, the
[decisions surface](#parked-decisions-apiv1runsruniddecisions)) or free them:
`POST /api/v1/jobs/:id/cancel` (initiative jobs) and `POST /api/v1/tasks/:id/stop` (board tasks)
both clear a park at the cost of the run's work. This matters doubly because the decision surface
does not yet answer every park type the engine has; the
[additions tracker](../../docs/initiatives/public-api-additions.md) is the authoritative list.

### Versioning & stability

**The public API is stable** ([ADR 0034](./adr/0034-public-api-stability.md)): `/api/v1`, the SDK
clients, and the webhook delivery contract do not change incompatibly. What that commits to:

- **Changes are additive**: new endpoints, new optional fields, new enum values, new error codes.
  Build clients to tolerate them (the official SDKs do by design); an addition bumps the OpenAPI
  `info.version` minor.
- **A breaking change never lands in place.** It ships as an incremental migration path plus a
  version change: the old shape keeps working while the new one is served beside it (a new field
  beside the old, a new `/api/v2` prefix for a path or semantics change), the deprecation and its
  window are documented here, and the old half is removed only in a later release after consumers
  have had time to move.
- **Scope semantics only ever widen without a migration path**; narrowing what a key may do is a
  break like any other.

## Quick start

```sh
BASE=https://<your-backend-origin>
AUTH="Authorization: Bearer cf_live_…"

# 1. What services does the board have?
curl -s -H "$AUTH" "$BASE/api/v1/services"

# 2. Which pipelines could a task run? (headlessStartable = safe with no human in the loop)
curl -s -H "$AUTH" "$BASE/api/v1/pipelines"

# 3. File a task under a service…
curl -s -H "$AUTH" -H 'content-type: application/json' \
  -d '{"title":"Add rate limiting to the login endpoint","taskType":"feature"}' \
  "$BASE/api/v1/services/$SERVICE_ID/tasks"

# 4. …start it (pipelineId optional when the task has a pinned pipeline)…
curl -s -H "$AUTH" -H 'content-type: application/json' \
  -d '{"pipelineId":"pl_standard_build"}' \
  "$BASE/api/v1/tasks/$TASK_ID/start"

# 5. …and follow it: poll the rich run projection, or stream it.
curl -s -H "$AUTH" "$BASE/api/v1/tasks/$TASK_ID/run"
curl -sN -H "$AUTH" "$BASE/api/v1/tasks/$TASK_ID/events"   # SSE

# 6. If the run parks on a decision (SSE `decision` event / run status `blocked`):
curl -s -H "$AUTH" "$BASE/api/v1/runs/$RUN_ID/decisions"

# 7. The period's spend + budget position, for a dashboard:
curl -s -H "$AUTH" "$BASE/api/v1/usage"
```

The headless-job flow is the same shape one level up: `POST /api/v1/jobs` with
`{ pipelineId, input }` returns `202 { jobId, links: { self, events } }`; poll `GET /jobs/:id` or
stream `GET /jobs/:id/events`. Headless jobs are **inline-only**: nothing is pushed to GitHub.

## Client SDKs

Official clients ship for four languages, so most integrations should not be writing HTTP by hand:

| Language      | Install                                                    |
| ------------- | ---------------------------------------------------------- |
| TypeScript    | `npm install @cat-factory/sdk`                             |
| Python        | `pip install cat-factory-sdk`                              |
| Go            | `go get github.com/kibertoad/cat-factory/sdk/go@latest`    |
| Java / Kotlin | `ai.catfactory:cat-factory-sdk` (one artifact serves both) |

Their models and operation methods are **generated from [`docs/openapi.json`](../../docs/openapi.json)**
(itself generated from the Valibot route contracts), so a client cannot drift from the
surface documented below. They also implement the conventions on this page for you: keyset
auto-pagination, SSE framing, bounded retries on idempotent requests only, and an error type per
status class with the machine-readable `code` exposed verbatim.

Details, the design rules the four share, and the Java/Kotlin story:
[`sdk/README.md`](../../sdk/README.md).

### From an MCP host

This surface is also served as **Model Context Protocol tools**, so a model in an MCP host can plan
work on the board, start and watch runs, answer parked decisions and read a run's telemetry. The tool
table is generated from the same spec, over the same TypeScript client, so it inherits every
convention on this page rather than re-stating them.

Two ways in, same server behind both:

| Path                                | Reach it with             | Use it when                                                          |
| ----------------------------------- | ------------------------- | -------------------------------------------------------------------- |
| **Hosted** `POST /api/v1/mcp`       | a URL and a key           | the host speaks HTTP MCP (claude.ai, Claude Desktop, a hosted agent) |
| **stdio** `@cat-factory/mcp-server` | `npx`, a per-host process | the host spawns servers, or you want per-host tool filters           |

#### Hosted (`POST /api/v1/mcp`)

Nothing to install: point the host at the endpoint and authenticate exactly as every other call on
this page does.

```sh
# Claude Code, for example:
claude mcp add --transport http cat-factory $BASE/api/v1/mcp \
  --header "Authorization: Bearer cf_live_…"
```

What to know about it:

- **The key's SCOPE decides the tool list.** A `read`-scoped key is served only the tools that change
  nothing, and the server's instructions say that a wider key would expose the rest, so a model asks
  for one instead of reporting the platform as unable to write. Above `read` the whole table is
  listed and each tool's own rung is enforced by the endpoint it calls: a `write` key calling
  `tasks_delete` gets the same `insufficient_scope` refusal `DELETE /api/v1/tasks/{id}` would give
  it, as tool content the model can read and act on.
- **Every tool call is one `/api/v1` request under YOUR key.** Nothing is reachable here that the
  same key could not reach with `curl`. Each one carries a `cat-factory-mcp/<version>` `User-Agent`,
  so an audit trail shows that a model made the call, and it INHERITS the MCP request's
  `X-Request-Id`: the tool call and the API call it caused share one correlation id, which is what
  makes "which tool call produced this refusal" answerable. Supply your own `X-Request-Id` on the
  MCP request and both halves are logged under it.
- **Stateless, and it answers JSON.** No session to establish or tear down, so `GET` (the
  server-to-client event stream) and `DELETE` (end a session) are answered `405`. Watching a run
  means polling `tasks_get_run` / `jobs_get`, the same as on the stdio path.
- **A JSON-RPC batch is one request that fans out.** The protocol permits an array of calls in one
  `POST`, and each becomes its own `/api/v1` request, so a batch costs the deployment in proportion
  to its length rather than to the one HTTP call it arrived as. Sized like any other public-API
  usage: the per-tool result ceiling still applies to each entry, and the key's scope still gates
  each one.
- **The endpoint is public surface** under the stability contract above, from its first release. It
  is deliberately NOT in [`docs/openapi.json`](../../docs/openapi.json): a JSON-RPC endpoint has no
  operation shape to describe, and describing it would mint an SDK method in four languages for a
  protocol none of those clients speaks. This section is what carries the obligation instead, which
  has one consequence worth stating: because the endpoint is absent from the spec, its arrival did
  not move `info.version`, and a change to it will not either. The spec's version tracks the
  described surface; THIS section is the changelog for the part it cannot describe.
- **From a browser origin it needs `Mcp-Protocol-Version` allow-listed**, which the shipped CORS
  configuration does. Worth knowing because a Streamable HTTP client sends that header on every
  request after `initialize` and on none before it, so a deployment that narrows
  `CORS_ALLOWED_ORIGINS` and strips the header sees the handshake succeed and every later call fail
  in the browser only. Server-side hosts (a hosted connector, a CLI) never send a preflight.
- **The per-host tool filters below are stdio-only.** A deployment-wide filter here would narrow what
  an already-scoped key may do, which is a break rather than a convenience; per-workspace selection
  is [tracked separately](../../docs/initiatives/mcp-maturation.md).

#### stdio (`@cat-factory/mcp-server`)

Needs no backend deployment of your own, and it is the only path for a host with no HTTP MCP
support.

```jsonc
{
  "mcpServers": {
    "cat-factory": {
      "command": "npx",
      "args": ["-y", "@cat-factory/mcp-server"],
      "env": { "CAT_FACTORY_BASE_URL": "$BASE", "CAT_FACTORY_API_KEY": "cf_live_..." },
    },
  },
}
```

Here too the key's SCOPE decides what the model may do: mint the narrowest one that does the job. This
path adds per-host filters on top (`CAT_FACTORY_MCP_GROUPS`, `CAT_FACTORY_MCP_TOOLS`,
`CAT_FACTORY_MCP_EXCLUDE_TOOLS`, `CAT_FACTORY_MCP_READ_ONLY`) that narrow what ONE host can see; they
are a convenience rather than a boundary, since the key still carries whatever scope it was minted
with.

The two SSE endpoints are deliberately not tools on either path (a tool call has no streaming
channel), so watching a run from a host means polling `tasks_get_run` / `jobs_get`, which the server's
instructions say in so many words. The env-var table and a worked flow (create, start, poll, decide):
[`sdk/mcp/README.md`](../../sdk/mcp/README.md).

Everything below still applies: the SDKs are a typed skin over exactly these endpoints, and the
error codes, scopes and paging rules are the same whichever you use.

## Reference

Scope column = the minimum rung. Refusal codes are in the [conventions table](#the-error-envelope).

### Jobs (headless runs)

A headless job executes a **public, inline pipeline** against a supplied brief, anchored on an
internal block; it is not a board task and never touches GitHub. Jobs are double-scoped: this
surface only ever sees runs it created, never the workspace's ordinary board runs.

| Method / path                  | Scope    | Behaviour                                                                                                                                                                                            |
| ------------------------------ | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/v1/jobs`            | `write`¹ | Start a run. Body `{ pipelineId, input (≤50k chars), title? (≤200) }` → `202 { jobId, status, links: { self, events } }`. Capped at **5 in-flight** runs per workspace (`429 too_many_active_runs`). |
| `GET /api/v1/jobs`             | `read`   | List this surface's jobs, newest first. `?limit=`, `?cursor=`, `?status=running\|succeeded\|failed`, `?since=<epoch-ms>`.                                                                            |
| `GET /api/v1/jobs/:id`         | `read`   | One job: `{ jobId, status, pipelineId, createdAt, result, error }`. `result.output` is the final agent reply, `result.data` its structured output (when produced).                                   |
| `POST /api/v1/jobs/:id/cancel` | `write`  | Cancel (idempotent; a terminal job comes back as-is). The escape hatch for a parked run.                                                                                                             |
| `GET /api/v1/jobs/:id/events`  | `read`   | SSE stream; see [Streaming](#streaming-sse).                                                                                                                                                         |

¹ Starting a pipeline that can park on a human requires `decide`; the `403
pipeline_requires_decide_scope` message names which of its park surfaces are answerable through the
API and which are not.

The **coarse job status** hides board internals: internal `done` → `succeeded`, `failed` → `failed`,
everything else (running, spend-paused, parked) → `running`. The `?status=` filter uses the same
mapping, so it always agrees with the field it filters on.

### Services & tasks

| Method / path                            | Scope    | Behaviour                                                                                                                                                                                                                                                                                                                       |
| ---------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/v1/services`                   | `read`   | The board's service frames: `{ serviceId, title, description, type, status }`.                                                                                                                                                                                                                                                  |
| `POST /api/v1/services/:serviceId/tasks` | `write`  | Create a task. Body `{ title (1–200), description? (≤2000), taskType?, ticket?, documents? }` (`taskType` defaults to `feature`; `recurring` is not creatable here). See [Filing a task from a tracker ticket](#filing-a-task-from-a-tracker-ticket) and [Attaching requirements documents](#attaching-requirements-documents). |
| `GET /api/v1/services/:serviceId/tasks`  | `read`   | The service's whole task subtree (frame + modules), paginated. `?limit=`, `?cursor=`, `?status=`.                                                                                                                                                                                                                               |
| `GET /api/v1/tasks/:taskId`              | `read`   | One task: `{ taskId, serviceId, title, description, taskType, status, progress, runId, pullRequestUrl }`.                                                                                                                                                                                                                       |
| `PATCH /api/v1/tasks/:taskId`            | `write`  | Edit `title` / `description` (the two human-authored fields; an empty patch is a no-op).                                                                                                                                                                                                                                        |
| `POST /api/v1/tasks/:taskId/start`       | `write`¹ | Run it. Body `{ pipelineId? }`; falls back to the task's pinned pipeline (`400 pipeline_required` with neither). `202` with the task projection.                                                                                                                                                                                |
| `POST /api/v1/tasks/:taskId/stop`        | `write`  | Stop the in-flight run (records `cancelled`; the task stays retryable). `409 no_run` when nothing is running.                                                                                                                                                                                                                   |
| `POST /api/v1/tasks/:taskId/retry`       | `write`  | Retry a failed run. `202`; refusals: `no_run`, `individual_model_unsupported`, engine 409s (e.g. not retryable).                                                                                                                                                                                                                |
| `DELETE /api/v1/tasks/:taskId`           | `admin`  | Delete the task **and its run history**. Destructive; `204`.                                                                                                                                                                                                                                                                    |

¹ Starting a pipeline that can park on a human requires `decide`, exactly as on `POST /jobs`. See
the paragraph below for what counts as a park.

Task `status` is the real lifecycle (`planned` / `ready` / `in_progress` / `blocked` / `pr_ready` /
`done`): a decoupled public mirror of the board status, stable even if the board grows internal
states.

Board-task `start` applies the **same parking rule** as `POST /jobs`, and a pipeline parks in any of
three ways:

- an **approval gate** on an enabled step;
- an inline **review or brainstorm** kind (`requirements-review`, `clarity-review`, and the two
  brainstorms), which sets the run `blocked` awaiting an answer;
- an unbounded **human-wait gate** (`human-review`), a gate step whose poll never times out because
  it is waiting for a person to review the PR.

Any of them needs a `decide`-scope key (`403 pipeline_requires_decide_scope`; the refusal names this
surface's exit, `POST /tasks/:taskId/stop`). Note that this covers the shipped **Adaptive build**
preset, which carries a risk-gated `human-review`: a `write`-only key cannot start it. The
unconditional presets (`Standard build`, `Simple build`) never park and stay `write`-startable.

#### Filing a task from a tracker ticket

An intake integration usually already holds the ticket the work comes from. Name it on the create
and the platform imports the issue and ATTACHES it to the new task, instead of you flattening it
into `description`:

```http
POST /api/v1/services/svc_api/tasks
{ "title": "Fix cat photo 404s", "taskType": "bug",
  "ticket": { "source": "jira", "ref": "https://acme.atlassian.net/browse/PROJ-1" } }
```

`source` is a tracker this workspace has connected and enabled (`jira` / `github` / `linear`, or a
`<ns>:<name>` source the deployment registered). `ref` is the issue's canonical key OR its full
URL: the provider's own parser resolves either, so you can forward whichever form your webhook
carried without knowing how the platform keys the issue.

That link, not the ticket's text, is what the rest of the platform runs on. Every agent step
re-reads the live issue as context (status, labels, description, comments), the run's clarification
questions are written back onto the issue, a reply typed there resolves against the parked run, and
the recurring intake sweep treats the issue as taken. `description` stays your own framing and is
never overwritten.

Two refusals matter:

- **The ticket is resolved before the task is created**, so an unconfigured or disabled source, a
  ref the provider cannot parse, or an issue the tracker will not serve refuses the whole request
  and leaves the board untouched. The other order would hand you a `201` for a task that carries no
  ticket and runs on its title alone.
- **One task per ticket.** A ticket already linked comes back `409` with
  `details.reason: "ticket_already_linked"` and `details.taskId` naming the task that holds it, so
  a redelivered webhook follows the existing task rather than filing a duplicate. You need no
  bookkeeping of your own to stay idempotent.

That second one holds under CONCURRENCY, which is the case a redelivery actually produces: two
deliveries of one ticket in flight together are decided by a conditional write, not by whichever
read happened first, so exactly one of them gets a task and the other gets the `409` naming it.
A filing that loses is rolled back off the board rather than left behind as a task with no ticket,
so retrying on the `409` never accumulates duplicates. The one state a retry cannot be spared is a
store failure at the moment of the claim: that answers `5xx`, and the retry either finds the
ticket taken (the write had landed) or files cleanly (it had not).

**Deleting the task releases its ticket.** The link is what the `409` is about, and it goes with the
block, so a ticket whose task was deleted files cleanly again rather than refusing forever against a
task that no longer exists. Nothing about the ticket itself is touched: the issue stays in the
tracker, and its projection (body, comments, history) survives the delete. The same delete also
returns the ticket to the recurring intake sweep's candidate pool.

The linkage is not projected onto the task resource: a `201` already means the ticket is attached,
and `409` already names the task for one that was.

#### Attaching requirements documents

A task's `description` is capped at 2,000 characters because it is the task's own framing, echoed
into every prompt. A specification is not that, and there was previously nowhere on this surface to
put one: the 50,000-character `POST /jobs` brief drives inline pipelines that never touch a
repository, and the app's own "attach a document" flow is session-authed. `documents` closes that
gap. Each entry is attached to the new task as context, and the full text is what agents receive:
materialised into the run's checkout under `.cat-context/` for a container agent to open, folded
into the prompt for an inline one.

Two forms, differing only in where the text comes from:

```http
POST /api/v1/services/svc_api/tasks
{ "title": "Split payments at checkout",
  "description": "From the payments squad.",
  "documents": [
    { "kind": "source", "source": "confluence", "ref": "https://acme.atlassian.net/wiki/spaces/ENG/pages/4242" },
    { "kind": "upload", "title": "Checkout PRD", "content": "# Checkout PRD\n\n## Goal\n…" }
  ] }
```

- **`kind: "source"`** NAMES a page in a document source this workspace has connected
  (`confluence`, `notion`, `github`, `figma`, `zeplin`, `linear`). `ref` is the page's id or its
  full URL, the same grammar the app's own import takes. The platform fetches and projects it, so
  the page stays the source of truth and a later re-import picks up edits. The GitHub docs source
  needs no separate connect step: it rides the workspace's installed App, so
  `{ "source": "github", "ref": "acme/api:docs/checkout-prd.md" }` works wherever the App does.
  A page the source serves but which turns out to be BLANK (a permission-limited Confluence page,
  an empty Notion page) is not caught here: the create succeeds and the run's first step refuses
  with `details.reason: "context_document_unreadable"`, naming the page.
- **`kind: "upload"`** CARRIES the text (Markdown, up to 100,000 characters). For a caller that
  generated the spec, holds it in a file, or whose deployment has connected no document source at
  all. There is no page behind it, so nothing re-fetches it and it shows in the app with no source
  link: the bytes you send are what every agent on the run reads.

At most 10 documents per create, in the order agents should read them.

Four refusals matter:

- **Everything is resolved before the task is created.** An unconfigured source, a ref the provider
  cannot parse, a page it will not serve, or an upload with no readable text refuses the whole
  request and leaves the board untouched. The other order hands you a `201` for a task you believe
  carries its spec, running on its title alone.
- **An upload with no readable text is refused** (`422`) rather than stored. A body that renders to
  nothing would reach the agent as an empty attachment, so it is caught while you still hold the
  bytes and can fix them, rather than costing you the first step of a run.
- **One task per document.** A document already attached to another live task comes back `409` with
  `details.reason: "document_already_linked"` and `details.taskId` naming the task that holds it.
  A document carries a single attachment, so a second attach would MOVE it: the earlier task would
  lose a document it was created with, and nothing in its next run would say so. Attach a separate
  copy (upload the text again), or detach it from the other task first. A link naming a task that
  has since been deleted is not a holder, so a deleted task never strands its documents.
- **A `201` means the task carries every document you named.** If an attachment fails to land after
  the task is created, the task is taken back off the board and you get the error, so your retry
  files it once and whole.

A refused request leaves nothing behind to clean up: pages resolve onto the same row every time
(they are keyed by their ref), and uploads are stored only once the whole list has resolved, so
retrying in a loop cannot fill the workspace with copies of a spec that was never attached.

The per-document cap bounds one attachment; the whole attached corpus (documents plus any linked
tracker issues) is bounded by the run's materialised-context budget of ~256 KB. Overflowing it
refuses the run's first dispatch with `details.reason: "context_documents_over_budget"`, naming
what did not fit.

Documents attached this way are ordinary workspace documents: they appear in the app alongside
imported pages, and a human can detach or re-attach them there.

The inline-only rule stays jobs-only: a `decide` key may start container pipelines on board tasks.
Parks raised dynamically mid-run (an agent-raised decision, a judge park) are not statically
knowable, so they do not gate the start; see the
[additions tracker](../../docs/initiatives/public-api-additions.md) for which parks the decision
surface can answer.

### Task runs & streaming

| Method / path                      | Scope  | Behaviour                                                                                                                                       |
| ---------------------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/v1/tasks/:taskId/run`    | `read` | The rich run projection: `{ runId, taskId, status, createdAt, currentStep, steps[], pullRequest, error }`. `404 no_run` before the first start. |
| `GET /api/v1/tasks/:taskId/events` | `read` | SSE stream of that projection; see [Streaming](#streaming-sse).                                                                                 |

Run `status` distinguishes the states a caller reacts to: `running`, `blocked` (parked on a human;
go read `/runs/:runId/decisions`), `paused` (spend-gated), `done`, `failed`. Each step reports
`{ agentKind, state, progress, subtasks }`, with live subtask counts while a container step works.

#### Streaming (SSE)

Both `/events` endpoints are `text/event-stream` responses driven by a 1-second poll of the
persisted run. Frames are **de-duplicated** (a frame is sent only when the payload changed) and
there is **no heartbeat**, so a quiet run produces a quiet stream. Event names:

| Event      | Meaning                                                                                                                                                      |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `progress` | The run advanced; data is the full job / run projection (same shape as the GET).                                                                             |
| `decision` | The run just **parked** on a human decision. Answer via `/runs/:runId/decisions`; the stream stays open, and a later park after a resume is announced again. |
| `done`     | Terminal success. Stream closes.                                                                                                                             |
| `error`    | Terminal failure. Stream closes.                                                                                                                             |
| `stopped`  | (Jobs stream only) the run ended in a state that still projects as `running` (e.g. cancelled). Stream closes.                                                |
| `timeout`  | The stream hit its **5-minute** cap; data `{}`. Nothing is wrong; reconnect to keep watching.                                                                |

A revoked key cuts a live stream within ~5 seconds. Streams are per-run reads bounded by their own
poll; for push at scale, register the [outbound webhook](#outbound-webhook-push) instead.

### Pipelines (discovery)

| Method / path           | Scope  | Behaviour                                                                                                  |
| ----------------------- | ------ | ---------------------------------------------------------------------------------------------------------- |
| `GET /api/v1/pipelines` | `read` | The workspace's pipelines (archived excluded): `{ pipelineId, name, steps[], public, headlessStartable }`. |

`public` marks the pipelines `POST /jobs` accepts. `headlessStartable` means every enabled
step is inline **and** nothing can park on a human: the pipeline can run end-to-end with no
interactive user. A pipeline can be startable on a board task without being either.

### Parked decisions (`/api/v1/runs/:runId/decisions`)

The external counterpart of every window the SPA offers a human when a run stops and waits for one.
Keyed by **run id** so it serves both surfaces: a headless initiative job and an ordinary board task run (very
possibly started by a human in the SPA). Reading needs `read`; **answering needs `decide`**.

Every action returns the run's **whole decision list**, re-read after the action:
`{ runId, taskId, status, parked, decisions[] }`. `parked: true` with an **empty** list means the
run is waiting on a park this surface does not model
([tracker](../../docs/initiatives/public-api-additions.md)); the one you should expect is
`human-review`, whose answer is a person approving the pull request on the VCS host.

| Method / path (under `/api/v1/runs/:runId/decisions`) | Scope    | Behaviour                                                                                                                                                                               |
| ----------------------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET …`                                               | `read`   | List the currently-parked decisions.                                                                                                                                                    |
| `POST …/approvals/:approvalId/approve`                | `decide` | Approve a gated step's proposal and advance. Body `{ proposal? (≤50000) }` — an edit replaces the agent's text and is what flows downstream.                                            |
| `POST …/approvals/:approvalId/request-changes`        | `decide` | Body `{ feedback (1–10000) }`; the gated step re-runs with the guidance folded in.                                                                                                      |
| `POST …/approvals/:approvalId/reject`                 | `decide` | Body `{ reason? (≤2000) }`; the run stops entirely (a terminal `rejected` failure the board can retry).                                                                                 |
| `POST …/approvals/:approvalId/resolve-exceeded`       | `decide` | Body `{ choice: "extra-round" \| "proceed" \| "stop-reset" }`; resolve a companion gate at its automatic-rework cap (`exceeded: true`), which refuses the plain approve.                |
| `POST …/questions/:decisionId/answer`                 | `decide` | Body `{ choice (1–4000) }`; answer a decision an agent raised. The asking step **re-runs** with it.                                                                                     |
| `POST …/requirements/findings/:itemId/reply`          | `decide` | Answer one reviewer finding. Body `{ reply (1–4000) }`.                                                                                                                                 |
| `PATCH …/requirements/findings/:itemId`               | `decide` | Body `{ status: "dismissed" \| "open" }`; dismiss a finding as not applicable, or reopen one.                                                                                           |
| `POST …/requirements/incorporate`                     | `decide` | Fold recorded answers into the requirements document. Body `{ feedback? (≤4000) }`. **Asynchronous**: the response shows `incorporating`; poll or stream for the next round.            |
| `POST …/requirements/re-review`                       | `decide` | One more reviewer pass over the incorporated document.                                                                                                                                  |
| `POST …/requirements/proceed`                         | `decide` | Settle the requirements phase and advance the run.                                                                                                                                      |
| `POST …/requirements/resolve-exceeded`                | `decide` | Body `{ choice: "extra-round" \| "proceed" \| "stop-reset" }`; resolve a review that hit its iteration cap.                                                                             |
| `POST\|PATCH …/clarity/…`                             | `decide` | The **same six verbs** as `…/requirements/…`, over the bug-report triage loop: `findings/:itemId/reply`, `findings/:itemId`, `incorporate`, `re-review`, `proceed`, `resolve-exceeded`. |
| `POST\|PATCH …/brainstorm/:stage/…`                   | `decide` | The same six verbs again, over a dialogue stage (`requirements` \| `architecture`), with the items called `options/:itemId` rather than `findings/:itemId`.                             |
| `POST …/fork/choose`                                  | `decide` | Body: exactly one of `{ forkId }` or `{ custom (≤8000) }`, plus optional `note (≤4000)`; choose the implementation approach.                                                            |
| `POST …/judge/resolve`                                | `decide` | Resolve a parked judge verdict: proceed anyway / bounce for rework / stop the run (same body the SPA sends).                                                                            |
| `POST …/input-gate/resolve`                           | `decide` | Body `{ choice: "recheck" \| "proceed" }`; answer the task's input check. `recheck` re-evaluates the task as it now stands, `proceed` waives the findings.                              |
| `POST …/pr-review/resolve`                            | `decide` | Body `{ action?: "finish" \| "fix" \| "post", findingIds?: string[] }`; record the curated selection. `fix`/`post` need ≥1 finding and **act on the real pull request**.                |
| `POST …/pr-review/findings/:findingId/dismiss`        | `decide` | Drop one finding from the review. Curation, not a resolution: the run stays parked.                                                                                                     |
| `POST …/pr-review/findings/:findingId/challenge`      | `decide` | Body `{ question? (≤4000) }`; dispatch a read-only investigator to uphold, strengthen or retract the finding.                                                                           |
| `POST …/human-test/confirm`                           | `decide` | The change works in the ephemeral environment: it is torn down and the run advances.                                                                                                    |
| `POST …/human-test/request-fix`                       | `decide` | Body `{ findings (1–10000) }`; dispatch a fixer against the tested environment, then rebuild it.                                                                                        |
| `POST …/visual-confirmation/approve`                  | `decide` | Approve the captured screenshots against the reference designs and advance.                                                                                                             |
| `POST …/visual-confirmation/request-fix`              | `decide` | Body `{ findings (1–10000) }`; dispatch a fixer against the captured screenshots.                                                                                                       |

Eleven decision kinds appear in `decisions[]`, discriminated by `kind`:

- **`approval-gate`**: a step marked `requiresApproval` finished and the run is holding its output
  up for a person — the simplest park, and the one any pipeline can carry. Carries the
  `approvalId` every action addresses, the `stepKind` and `stepIndex` whose output is being judged,
  the `proposal` itself, and the last `feedback`. **`exceeded: true` changes the verb**: the gate is
  a quality companion at its automatic-rework cap, the plain approve is refused (`409`), and
  `resolve-exceeded` is what settles it.
- **`agent-decision`**: an agent hit a fork mid-work and asked. Carries the `decisionId`, the
  `question` and the `options` it offered. Resolving **re-runs** the asking step with the choice
  folded in rather than advancing past it — the difference from an approval gate. Your `choice` is
  taken verbatim, so it may be one of the options or a steer of your own.

- **`requirements-review`**: the clarification loop. Findings carry a stable `itemId`, category,
  severity, status and any recorded `reply`; the decision carries `iteration` / `maxIterations` and
  the `incorporatedRequirements` document once one exists (that document is what downstream agents
  implement; read it before `proceed`). Loop: answer or dismiss every `open` finding →
  `incorporate` → the review converges, returns a fresh round, or hits its cap (`resolve-exceeded`).
- **`fork`**: materially different implementation approaches proposed before code is written, each
  with its full approach / trade-offs / risk text. Pick one or supply your own.
- **`judge`**: a rubric scored the work below the task's threshold: score, threshold, findings,
  and the `bounces` / `maxBounces` budget, resolved with proceed / bounce / stop.
- **`input-gate`**: the run stopped **before its first agent step** because the task states nothing
  an agent could act on, having spent nothing. The `issues[]` are machine-readable codes
  (`description_missing`, `description_placeholder`, `reproduction_missing`,
  `review_target_missing`, and the advisory `description_thin` / `success_criteria_missing`), so map
  them to your own copy rather than parsing prose. To clear it, **fix the task first**
  (`PATCH /api/v1/tasks/:taskId`) and then `recheck`: the fix is verified, never taken on trust, and
  a still-blocked recheck comes back as an ordinary `200` with refreshed findings because nothing
  went wrong. `proceed` waives the findings, which stay on the run under an `overridden` verdict.
  This is the one park that depends on the **task** rather than the pipeline, which is why a
  `write`-scope key is refused at start (`pipeline_requires_decide_scope`) for a task it would
  hold, rather than being handed a run it cannot answer.
- **`clarity-review`**: the bug-report triage loop — the requirements review's twin over a
  different document, settling `clarifiedReport` instead of `incorporatedRequirements`. It is its
  own kind rather than a variant of `requirements-review` because a run can carry **both**: a
  bugfix pipeline clarifies the report and then reviews the requirements derived from it.
- **`brainstorm`**: a structured dialogue that proposes concrete `options` with their trade-offs
  and converges on one direction. Keyed by `(task, stage)`, so a decision list can carry **two**
  brainstorm entries at once (`requirements` and `architecture`) — key your own state by
  `kind` + `stage`, not `kind` alone.
- **`pr-review`**: the read-only reviewer sliced an open pull request and the run is waiting for
  someone to curate which findings matter. Carries the `slices`, the severity-ordered `findings`
  (each with its path/line anchor, `suggestedFix` and any `challenge` verdict) and the current
  `selectedFindingIds`. Reachable only through `POST /tasks/:taskId/start`, since a `pr-reviewer`
  step is container-backed.
- **`human-test`**: a live ephemeral `environment` is up and the run is waiting for someone to
  exercise it. `degradedReason` non-null means no environment was provisioned and the change has
  to be tested against the PR branch by hand.
- **`visual-confirmation`**: the UI tester's screenshots are waiting to be compared against the
  reference designs. `pairs` carries the artifact ids per view, but **the images are not readable
  over this API** — resolving an id to an image needs the app, so approving on this projection
  alone approves screenshots you have not seen.

The last two are exposed with their limits stated rather than sold as equivalent to the rest: the
verbs are mechanical, but the judgement they record is the one an API consumer is least able to
supply. They earn their place for an integration that drives its own human through a different UI,
or that has a real automated check to point at `environment.url`.

Answers ride the **same service methods** the SPA calls, so racing surfaces (a human in the app and
your integration) are already arbitrated: whoever answers first wins, no locking needed on your
side. That sharing is also why the list only ever offers you verbs the engine will accept: several
specialised parks ride the same internal approval flag as a plain gate, and each is reported as
**its own** kind rather than as `approval-gate`, because the engine refuses the generic
approve/request-changes/reject on them.

### Notification inbox

The workspace's open notification cards: the human-gated run tails (a PR awaiting merge review, a
run whose CI could not be fixed). `act` runs the card's typed side-effect; on a `merge_review` /
`pipeline_complete` card that is a **real merge** of the PR, which is why it sits at `admin`.

| Method / path                            | Scope   | Behaviour                                                                                                                                                                                                                        |
| ---------------------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/v1/notifications`              | `read`  | All **open** cards (unpaginated; humans keep this list short).                                                                                                                                                                   |
| `POST /api/v1/notifications/:id/act`     | `admin` | Run the side-effect, resolve the card: `merge_review` / `pipeline_complete` → merge the PR; `ci_failed` / `test_failed` → retry the run. Any other type → `409 notification_not_actionable` (resolve it in the app, or dismiss). |
| `POST /api/v1/notifications/:id/dismiss` | `write` | Resolve the card with no side-effect (idempotent).                                                                                                                                                                               |

### Usage & budget

| Method / path       | Scope  | Behaviour                                                      |
| ------------------- | ------ | -------------------------------------------------------------- |
| `GET /api/v1/usage` | `read` | The current period's spend + budget position, as one resource. |

Response: `{ periodStart, currency, budget, rows }`. `budget` is the **metered** position the spend
safeguard acts on: `costSpent`, `costLimit` and `exceeded: true` when runs are paused at the cap.
`rows` is the per-`(billing, vendor, provider, model)` breakdown. **Do not sum the two billing
kinds**: a `subscription` row's `costEstimate` is illustrative (flat-rate plans bill nothing per
token); only `metered` rows are money. Workspace tier only, by design: a workspace key never learns
a sibling workspace's spend.

### Run debugging (`/api/v1/debug/*`)

Nine read-only endpoints for diagnosing a run from outside the browser: run index, per-run
overview with precomputed signals, and budgeted drill-downs into model calls, agent context,
searches, the agents' TOOL CALLS (what they actually did, in order) and provisioning logs. Same
keys, `read` scope. Fully documented in [`debug-api.md`](./debug-api.md).

### Outbound webhook management

`GET|PUT|DELETE /api/v1/notification-webhook`, `admin` scope: register the endpoint this workspace
pushes to, read what is registered, or unregister. Documented with the delivery contract it
configures, in [Outbound webhook](#outbound-webhook-push) below.

## Outbound webhook (push)

Polling has no answer for the two cases that matter most: a parked run waits **indefinitely**, and a
fully-successful run raises no notification at all. A workspace can register **one** outbound HTTPS
endpoint and subscribe it to any of three delivery families:

- **Notification cards**: the same cards as `GET /api/v1/notifications`, pushed as they are raised
  and again as they are resolved.
- **Run-lifecycle events**: `run.started` / `run.completed` / `run.failed`, one delivery per
  transition, including the happy path that raises no card.
- **Platform-health alerts**: `platform_health.firing` / `platform_health.resolved`, the deployment
  watching **itself**. This is the family to wire an on-call rotation to.

### Register the endpoint

`admin` scope. Enrolment is part of the API, so an integration installs its own receiver rather than
asking someone to open a browser (there is deliberately no SPA panel; the session-authed
`GET|PUT|DELETE $BASE/workspaces/$WS/notification-webhook`, behind `integrations.manage`, remains and
drives the same service):

```sh
curl -s -X PUT -H "Authorization: Bearer cf_live_pak_…" -H 'content-type: application/json' \
  -d '{
    "url": "https://hooks.example.com/cat-factory",
    "secret": "<16-200 chars, used to sign deliveries>",
    "types": [],
    "runEvents": ["run.started", "run.completed", "run.failed"],
    "alertEvents": ["platform_health.firing", "platform_health.resolved"],
    "enabled": true
  }' \
  "$BASE/api/v1/notification-webhook"
```

| Route                                 | Scope   | Notes                                                          |
| ------------------------------------- | ------- | -------------------------------------------------------------- |
| `GET /api/v1/notification-webhook`    | `admin` | `{ "webhook": … }`, or `{ "webhook": null }` when none is set. |
| `PUT /api/v1/notification-webhook`    | `admin` | Register, edit or rotate. Returns the stored config.           |
| `DELETE /api/v1/notification-webhook` | `admin` | Unregister. Idempotent, `204`.                                 |

`GET` returns the config with `hasSecret: true|false`; the secret itself is **write-only**, sealed
at rest, never readable back. An `admin` key can rotate the signing secret but never learn the
stored one, so a leaked key cannot be used to forge deliveries your receiver would verify. `DELETE`
unregisters (idempotent, `204`).

**`PUT` is keep-on-omit in every field**, `url` included: a body states what changes and leaves the
rest alone, so subscribing an existing endpoint to a new family is a one-field call.

```sh
curl -s -X PUT -H "Authorization: Bearer cf_live_pak_…" -H 'content-type: application/json' \
  -d '{"alertEvents": ["platform_health.firing"]}' "$BASE/api/v1/notification-webhook"
```

`url` is required only on the **first** `PUT`, when there is nothing registered to keep; a body that
names none against an empty workspace is refused with `details.reason: "webhook_url_required"`. The
uniformity is a safety property, not a convenience: a mandatory re-send would make every routine
edit carry an endpoint the caller did not mean to change, and a client re-sending a `url` it cached
before someone else rotated the receiver would quietly redirect every future delivery back to the
old one while appearing to add a subscription.

Three filters, and the first has the **opposite** empty semantics to the other two. All three are
deliberate:

- `types: []` (or unset) means **the default card types**: the parked-decision and merge/CI tails
  (`requirement_review`, `clarity_review`, `decision_required`, `fork_decision_pending`,
  `merge_review`, `pipeline_complete`, `ci_failed`, `test_failed`). Name types explicitly to widen
  or narrow (system cards like `platform_health`, `budget_paused`, `key_drift` are excluded from the
  defaults but nameable).
- `runEvents: []` (or unset) means **none**: lifecycle events are opt-in per event, so a receiver
  registered for parked decisions does not silently start hearing about every run.
- `alertEvents: []` (or unset) means **none**, for the same reason and a sharper one: this family
  pages people.

**Alerts vs the `platform_health` card.** The card can also be named in `types`, and for a human
overseer it should be. Do not page on it: a card is delivered on every content change **and again
when a human acts on it or dismisses it**, and on the wire that dismissal is indistinguishable from
the sweep clearing the card because the deployment recovered — so an integration built on it closes
its incident whenever somebody tidies their inbox. The `alertEvents` family is produced by the
health sweep's own verdict, so `platform_health.resolved` means the platform observed recovery.

The URL must be public `https://`: loopback, RFC 1918, link-local, `.internal`/`.local` hosts and
embedded credentials are refused at registration **and re-checked on every delivery hop** (redirects
are followed at most 5 times, each hop re-validated; a cross-origin hop drops the body and auth
headers). For local development, a deployment can relax this with
`NOTIFICATION_WEBHOOK_ALLOW_URL_HOSTS` / `NOTIFICATION_WEBHOOK_ALLOW_HTTP_URLS`
([environment variables](../../docs/environment-variables.md)).

### Delivery contract

Every delivery is a `POST` with `content-type: application/json` and `user-agent: cat-factory`. The
three families share the endpoint and are told apart by shape: `notification`, `run` and `alert`
respectively.

```jsonc
// Notification card (carries `notification`)
{
  "deliveryId": "ntf_123-open",          // <notificationId>-<status>; re-delivered as …-acted / …-dismissed on resolve
  "sentAt": 1722600000000,
  "workspaceId": "ws_1",
  "runId": "exec_9",                      // lifted for routing; null on block-less system cards
  "taskId": "blk_4",
  "notification": { "id": "ntf_123", "type": "merge_review", "status": "open", "title": "…", "body": "…", … }
}

// Run-lifecycle event (carries `event` + `run`)
{
  "deliveryId": "exec_9:run.completed",   // <runId>:<event> - THE dedupe key
  "sentAt": 1722600000000,
  "workspaceId": "ws_1",
  "event": "run.completed",
  "run": {
    "runId": "exec_9", "taskId": "blk_4", "taskTitle": "…",
    "pipelineId": "pl_standard_build", "pipelineName": "Standard build",
    "startedAt": 1722599000000, "occurredAt": 1722600000000,
    "pullRequestUrl": "https://github.com/…/pull/42",   // null is a real answer on a terminal event
    "failure": { "kind": "…", "message": "…", "reason": null }   // run.failed only; null otherwise
  }
}

// Platform-health alert (carries `event` + `alert`)
{
  "deliveryId": "ntf_77:platform_health.firing:2:failure_rate_high",  // <cardId>:<event>:<transition>[:<reasons>]
  "sentAt": 1722600000000,
  "workspaceId": "ws_1",
  "event": "platform_health.firing",
  "alert": {
    "accountId": "acc_1",                 // health is aggregated per ACCOUNT - group on this
    "window": "1h",
    "occurredAt": 1722600000000,          // when the sweep observed THIS transition, not when the incident opened
    "conditions": [
      { "reason": "failure_rate_high", "value": 0.8, "threshold": 0.5 }
    ],
    "failingRuns": [                      // capped sample, THIS workspace only; [] when there is no run evidence
      { "executionId": "exec_9", "blockId": "blk_4", "failureKind": "agent", "createdAt": 1722599000000 }
    ],
    "failedTotal": 23                     // what the sample left out; null when it could not be read
  }
}
```

Semantics your receiver must honour:

- **Dedupe on `deliveryId`, never on the body.** `run.started` is exactly-once per run by
  construction; the terminal events are **at-least-once** (a durable replay can re-emit a settled
  run), and a replay re-stamps `sentAt` / `occurredAt`, so two deliveries of one transition are not
  byte-identical. One id comparison collapses them. Rationale: [ADR 0030](./adr/0030-public-api-surface.md).
- A `retry` / restart mints a **fresh run id** and announces it as a new `run.started`.
- Headless initiative jobs emit **no** lifecycle events (their anchor block is internal;
  `GET /api/v1/jobs/:id` and its SSE stream already serve them).
- Delivery is **best-effort**: 3 attempts (exponential backoff, 250 ms base), 5 s per attempt, 6 s
  total budget per delivery; a 4xx from your endpoint does not retry. A dead receiver never stalls a
  run, but it also means missed deliveries are possible, so treat the webhook as a trigger and the
  API as the source of truth. Failures are logged on the platform side for diagnosis.
- Answer fast (2xx) and process async: the 5-second per-attempt timeout includes your handler.

Three more that apply to platform-health alerts specifically, because an on-call integration is
built differently depending on them:

- **Edges only, and only when the firing set CHANGES.** The sweep runs every couple of minutes for
  the length of an incident and does not repeat itself, so silence means "nothing changed", never
  "recovered". One condition escalating to two is a change and pages again (with a new
  `deliveryId`); the same conditions still firing is not.
- **Dedupe an alert on `deliveryId` alone, not on the conditions and not on `occurredAt`.** The id
  carries a transition ordinal that counts the edges within one incident, because neither obvious
  substitute works: a condition set RECURS (escalating from `{A}` to `{A,B}` and subsiding to
  `{A}` is three transitions over two distinct sets, and keying on the set would drop the page
  saying it had subsided), while `occurredAt` over-separates, since the deployment may run several
  sweepers and two of them observing one transition stamp different times for it. The ordinal is
  derived from the platform's own record of the incident, so it is identical for a duplicate
  delivery and distinct for a real transition.
- **One account-level condition fans out per subscribed workspace.** Health is aggregated per
  account while endpoints are registered per workspace, so a receiver watching several workspaces of
  one account gets one delivery each. Group on `alert.accountId`.
- **The resolved edge follows the platform's own open card.** If a human dismisses the
  `platform_health` card from the in-app inbox while the condition is still firing, the sweep has
  nothing left to clear, so a later recovery emits no `platform_health.resolved` (the next change to
  the firing set raises a fresh card and delivers `firing` again). A receiver that cannot tolerate a
  hanging incident should auto-resolve on its own timer rather than wait for an edge the platform
  may have no state to produce.
- `reason` and `window` are plain strings, not closed enums: both vocabularies grow additively, and
  a deployment one release ahead of its receiver must still be able to page it. Route on the values
  you know and treat the rest as an unrecognised condition rather than as no condition.

### Verify signatures

When a `secret` is registered, every delivery carries:

- `x-cat-factory-timestamp`: epoch ms, equal to the body's `sentAt`
- `x-cat-factory-signature`: `v1=<hex HMAC-SHA256(secret, "<timestamp>.<raw body>")>`

The timestamp is bound into the MAC, so it can be trusted for replay rejection. Verify against the
**raw request bytes**, before any JSON parsing:

```js
import { createHmac, timingSafeEqual } from 'node:crypto'

function verifyDelivery(headers, rawBody, secret, maxSkewMs = 5 * 60 * 1000) {
  const timestamp = headers['x-cat-factory-timestamp']
  const signature = headers['x-cat-factory-signature'] ?? ''
  if (!signature.startsWith('v1=')) return false
  if (Math.abs(Date.now() - Number(timestamp)) > maxSkewMs) return false
  const expected = createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest()
  const given = Buffer.from(signature.slice(3), 'hex')
  return given.length === expected.length && timingSafeEqual(given, expected)
}
```

A delivery with no registered secret is sent unsigned; register one unless your endpoint is
otherwise authenticated.

## Extending the surface

For contributors adding or changing `/api/v1` endpoints, the short version, with the full rules in
[ADR 0030](./adr/0030-public-api-surface.md) (shape, paging, scoping) and the
[additions tracker](../../docs/initiatives/public-api-additions.md) (decision-surface slices and
their gotchas):

- Contract first in `@cat-factory/contracts` (`src/routes/public-api.ts` /
  `src/routes/public-decisions.ts`), handled in
  `backend/packages/server/src/modules/publicApi/`, delegating to the same service method the SPA
  calls.
- Regenerate the spec in the same PR: `pnpm build && pnpm gen:openapi` (CI fails on drift via
  `check:openapi`); a new named DTO needs `COMPONENT_SCHEMAS` + `OPERATION_DOCS` entries in
  `scripts/generate-openapi.mjs`.
- **Update this document**: the reference tables above are hand-maintained.
