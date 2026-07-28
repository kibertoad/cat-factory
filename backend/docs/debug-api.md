# Remote run debugging API (`/api/v1/debug/*`)

The read-only surface that lets something outside the browser answer **"why did this run fail,
stall, or cost that much"** — in practice, an LLM handed an API key and asked to diagnose a run.

Everything it returns was already captured: the per-call LLM telemetry, the per-dispatch agent
context, the searches an agent performed, and the provisioning event log (see
[`storage-and-retention.md`](./storage-and-retention.md) and the "Telemetry & agent-context
observability" section of the root [`CLAUDE.md`](../../CLAUDE.md)). What was missing is a way to
**walk** it: the SPA's observability drill-down loads a run's whole telemetry into a browser, which
is fine for a human with a scrollbar and useless for a caller with a fixed context budget.

## The design constraint

A single run can hold thousands of model calls, each with a prompt and a response, plus
agent-context snapshots that are megabytes apiece (they carry the full body of every injected
`.cat-context/*` file). A naive `GET /runs/:id/telemetry` would be a multi-hundred-megabyte
response on exactly the long, expensive runs someone wants to debug.

So the whole surface is shaped by one rule: **a response's size must be computable before the
request is made.** Four consequences, each visible in the wire contracts
(`@cat-factory/contracts` → `debug-api.ts`):

1. **Every list is keyset-paginated** with a hard `limit` ceiling (100). Cursors are opaque and
   ride the `(createdAt, id)` composite the store orders by — not a bare timestamp, because
   telemetry is written in bursts that share a millisecond and a timestamp-only cursor silently
   drops the ties.
2. **Fan-out lists never carry bodies; bodies are always a point read.** A page of snapshots
   carries sizes (`*Chars`) and identity only. The one opt-in exception is `?bodyChars=` on the
   LLM-call list, because "did this call come back empty?" is a triage question a size alone
   answers ambiguously.
3. **Truncation is reported, never silent.** Every body is a `debugText`:
   `{ text, chars, totalChars, truncated }`. A bare truncated string reads exactly like a short
   one, so a model would confidently report "the agent said nothing" from a payload that merely
   hit its budget.
4. **The overview is a map, not a dump.** `GET /debug/runs/:runId` costs a handful of SQL
   aggregates and reads no body at all. Its `sinks` block says which of the four detail endpoints
   have anything in them, so the expensive reads are only issued for data that exists.

Slicing and filtering happen **in SQL** (`substr` / `length` / the outcome predicate), so an
un-previewed page does not read the text columns out of the store at all.

## Auth

`Authorization: Bearer cf_live_…` — a public-API key, resolved to its workspace exactly like the
rest of `/api/v1` (see [`PublicApiController`](../packages/server/src/modules/publicApi/PublicApiController.ts)).
The whole surface needs the **`read`** rung of the scope ladder.

It is deliberately _not_ `admin`-gated. On this API `admin` also merges pull requests and deletes
tasks, so requiring it would mean handing a debugging agent a destructive key — strictly worse
than the exposure it was meant to prevent. What model text is retained at all stays governed where
it is captured: `LLM_RECORD_PROMPTS` (deployment) **and** the per-workspace `storeAgentContext`
setting. Turn either off and this surface has nothing to serve.

Treat a `read` key accordingly when handing one out: it now reaches **prompt and response bodies,
injected context files, and run diagnostics** (repo, control-plane host) that were previously
visible only to workspace members through the SPA's RBAC-gated observability drill-down. A `read`
key was always able to see task titles and run status; with this surface it can see everything the
telemetry store retains for its workspace.

Note the overview's `sinks.available` flag is **repository presence only** — it says whether this
deployment wired the store, not whether capture was on. A workspace that turned `storeAgentContext`
off (or a deployment without `LLM_RECORD_PROMPTS`) reads `available: true, count: 0` for the runs
it stopped capturing.

Scope is the **workspace**, which is wider than the task surface's `loadScopedRun` on purpose: a
service frame's blueprint run and a recurring bug-intake fire are exactly the runs someone asks
about, and a debugger that cannot see the run that failed is useless. A run outside the key's
workspace is a `404`, indistinguishable from one that never existed.

## Endpoints

| Method / path                                  | Returns                                                                                           |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `GET /api/v1/debug/runs`                       | The workspace's runs, newest first. `?status=`, `?since=`, `?limit=`, `?cursor=`                  |
| `GET /api/v1/debug/runs/:runId`                | The run's diagnostic **overview** (aggregates + signals)                                          |
| `GET /api/v1/debug/runs/:runId/llm-calls`      | Recorded model calls. `?agentKind=`, `?outcome=`, `?order=`, `?bodyChars=`, `?limit=`, `?cursor=` |
| `GET /api/v1/debug/llm-calls/:callId`          | One call, full bodies. `?bodyChars=`                                                              |
| `GET /api/v1/debug/runs/:runId/agent-context`  | Captured dispatches, **sizes only**. `?stepIndex=`, `?limit=`, `?cursor=`                         |
| `GET /api/v1/debug/agent-context/:snapshotId`  | One dispatch's prompts, fragments, injected files. `?bodyChars=`                                  |
| `GET /api/v1/debug/runs/:runId/search-queries` | Web searches the run's agents performed                                                           |
| `GET /api/v1/debug/runs/:runId/logs`           | The run's provisioning event log                                                                  |

The two point reads are addressed by the row's **own** id rather than nested under the run: the
list already handed the caller that id, and nesting would let a mismatched pair form a request that
looks well-typed and 404s for a reason the caller cannot see.

## The recommended walk

1. `GET /debug/runs?status=failed` — find the run.
2. `GET /debug/runs/:runId` — read `signals` first. They are precomputed derivations (failed calls,
   truncated output per agent kind, container evictions, provisioning failures, a cold prompt
   cache), ordered most-severe first, each with a `count`. A model that has to rediscover "13 of 40
   calls were truncated" by arithmetic over a JSON blob will sometimes get it wrong and will always
   spend context getting it right.
3. Follow the signal:
   - a **provisioning failure** → `/logs`. For a run whose container never came up there is no
     model telemetry at all, and this is the only place its cause of death is written.
   - **failed or truncated calls** → `/llm-calls?outcome=error` (or `?agentKind=…`), then
     `/llm-calls/:callId` for the bodies.
   - **the agent did the wrong thing** → `/agent-context` to see how large each dispatch's context
     was, then `/agent-context/:snapshotId` for the prompts it actually received.

### Reading a conversation

`GET /debug/runs/:runId/llm-calls?agentKind=coder&order=oldest&bodyChars=2000` walks one agent
kind's conversation forwards. Each call's `prompt` is the **delta** — only the messages that call
appended — because that is how the store keeps prompts (a container agent re-sends its whole
growing history every turn, so storing the full array per call is ~21× redundant). Concatenating
the deltas in order reconstructs the conversation, and `elidedLeadingMessages` says how many
earlier messages the delta sits on top of. That shape is also why the API never re-sends the shared
prefix to the caller either.

## Sizing a request

A page's worst case is `limit × 3 × bodyChars` characters of body for the LLM-call list, and
`limit × <row size>` for everything else (agent-context index rows carry no body; search and log
rows are small by construction). Ceilings: `limit ≤ 100`, `bodyChars ≤ 4 000` on a list and
`≤ 200 000` on a point read. A caller that wants a 50 kB page asks for `limit=25&bodyChars=650`.

Known bound: the store caps a single body at 512 kB, above the point read's 200 000-character
ceiling, so the largest bodies are returned as a leading slice. There is no offset parameter — the
tail of such a body is not reachable through this surface. `truncated` and `totalChars` always say
so, which is the property that matters: the caller knows it is reasoning over a prefix.

## Where it lives

- Wire contracts: `backend/packages/contracts/src/debug-api.ts` (+ `routes/debug-api.ts`)
- HTTP: `backend/packages/server/src/modules/publicApi/PublicDebugController.ts`
- Reads + projections: `backend/packages/orchestration/src/modules/debug/`
  (`RunDebugService.ts`, `debug.logic.ts`)
- Ports: kernel `llm-metrics.ts`, `agent-context.ts`, `agent-search-queries.ts`,
  `provisioning-log-repositories.ts`, and `ExecutionRepository.listRecent`
- Stores: `D1*` under `backend/runtimes/cloudflare/src/infrastructure/repositories/` ⇄ Drizzle
  under `backend/runtimes/node/src/repositories/drizzle/`

Cross-runtime parity is pinned twice: the per-store suites
(`llm-metrics-suite`, `agent-context-suite`, `agent-search-queries-suite`,
`provisioning-log-suite`) drive the real SQL on both runtimes, and
`suites/integration-public-debug.ts` drives the HTTP surface end to end and asserts every sink
reads `available: true` on the conformance facades (all of which wire the stores) — so a facade
that mounts the routes but forgets a telemetry repository fails there rather than shipping a
surface that reports the sink as unavailable.

## Mothership mode

The run index (`ExecutionRepository.listRecent`) is allow-listed on the machine RPC — runs are
org/durable state and live on the mothership. The **telemetry** reads are not, and must not be:
telemetry is local-first by design, so a mothership-mode node reads its own telemetry store. See
[`docs/initiatives/mothership-mode.md`](../../docs/initiatives/mothership-mode.md).
