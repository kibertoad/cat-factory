# Remote run debugging API (`/api/v1/debug/*`)

> **Using it is on the website**:
> [Debug a Run from Outside the Browser](https://www.catfactory.ai/operate/debugging-a-run.html) owns the
> endpoint table, the signal-by-signal playbook, the body search, spend attribution, the export
> bundle and the size ceilings. This page is the DESIGN: the one constraint every endpoint obeys,
> and the three couplings a change here breaks.

The read-only surface that lets something outside the browser answer **"why did this run fail,
stall, or cost that much"**: in practice, an LLM handed an API key and asked to diagnose a run.

Everything it returns was already captured: the per-call LLM telemetry, the per-dispatch agent
context, the searches an agent performed, the tool calls it made, and the provisioning event log (see
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
request is made.** Five consequences, each visible in the wire contracts
(`@cat-factory/contracts` → `debug-api.ts`):

1. **Every list is keyset-paginated** with a hard `limit` ceiling (100). Cursors are opaque and
   ride the `(createdAt, id)` composite the store orders by, not a bare timestamp, because
   telemetry is written in bursts that share a millisecond and a timestamp-only cursor silently
   drops the ties.
2. **Fan-out lists never carry bodies; bodies are always a point read.** A page of snapshots
   carries sizes (`*Chars`) and identity only. The one opt-in exception is `?bodyChars=` on the
   LLM-call list, because "did this call come back empty?" is a triage question a size alone
   answers ambiguously.
3. **Finding is server-side work too.** The LLM-call list takes a `?contains=` body search
   applied as SQL `LIKE`, so locating a known marker across thousands of calls costs one
   request: paging every body through the caller's own context to grep it there would be the
   multi-hundred-megabyte dump re-entering through the side door. Matched rows report **where**
   the match sits (`matchOffset`), which feeds the point read's window directly. Every other
   narrowing (`?agentKind=`, `?phase=`, `?outcome=`) is SQL for the same reason: a filter applied
   after the read has already paid for the rows it throws away, and it spends the page's `limit`
   on them.
4. **Truncation is reported, never silent, and every slice knows its place.** Every body is a
   `debugText`: `{ text, chars, offset, totalChars, truncated }`. A bare truncated string reads
   exactly like a short one, so a model would confidently report "the agent said nothing" from a
   payload that merely hit its budget, and a slice that didn't state its `offset` could not be
   stitched against its neighbours.
5. **The overview is a map, not a dump.** `GET /debug/runs/:runId` costs a handful of SQL
   aggregates and reads no body at all. Its `sinks` block says which of the four detail endpoints
   have anything in them, so the expensive reads are only issued for data that exists.

Slicing, filtering **and searching** happen in SQL (`substr` / `length` / `instr` / the outcome
predicate), so an un-previewed page does not read the text columns out of the store at all, and a
searched page spends its `limit` on matches only.

## Why the path is `/debug`

Considered against the more resource-oriented alternatives and kept deliberately:

- **Not `/api/v1/runs/:id/…`**: that prefix belongs to the task-scoped public surface (the parked
  decisions, and the run-evidence reads that later joined them), which resolves runs through the
  narrower `loadScopedRun`. Mounting reads with a _different_ (workspace-wide) authorization rule
  under the same resource path would put two access semantics behind one name, which is a trap for
  both callers and reviewers. That rule is why
  [`GET /api/v1/runs/:runId/report`](./public-api.md#run-evidence-report--outcome--artifacts) took the
  NARROWER scope rather than this surface's, despite serving a similar audience: what decides a
  path's authorization model is the path, not the feature.
- **Not `/observability` or `/telemetry`**: those name the _capture_ subsystems, and this surface
  is neither: the run index and the provisioning log are not telemetry, and what is served here
  is a purpose-built diagnostic **projection** (budgeted slices, derived signals, availability
  flags), not the canonical stores.
- `/debug` names the caller's intent (the same way `/search` does on APIs that serve
  purpose-shaped projections) and it is short in every one of the many tool calls an LLM caller
  makes. The resources under it are still nouns (`runs`, `llm-calls`, `agent-context`); the
  namespace states what they are _for_.

## Auth

`Authorization: Bearer cf_live_…`: a public-API key, resolved to its workspace exactly like the
rest of `/api/v1` (see [`PublicApiController`](../packages/server/src/modules/publicApi/PublicApiController.ts)).
The whole surface needs the **`read`** rung of the scope ladder. How keys are minted and the rest
of the `/api/v1` surface: [`public-api.md`](./public-api.md).

It is deliberately _not_ `admin`-gated. On this API `admin` also merges pull requests and deletes
tasks, so requiring it would mean handing a debugging agent a destructive key: strictly worse
than the exposure it was meant to prevent. What model text is retained at all stays governed where
it is captured: `LLM_RECORD_PROMPTS` (deployment) **and** the per-workspace `storeAgentContext`
setting. Turn either off and this surface has nothing to serve.

Treat a `read` key accordingly when handing one out: it now reaches **prompt and response bodies,
injected context files, and run diagnostics** (repo, control-plane host) that were previously
visible only to workspace members through the SPA's RBAC-gated observability drill-down. A `read`
key was always able to see task titles and run status; with this surface it can see everything the
telemetry store retains for its workspace.

Note the overview's `sinks.available` flag is **repository presence only**: it says whether this
deployment wired the store, not whether capture was on. A workspace that turned `storeAgentContext`
off (or a deployment without `LLM_RECORD_PROMPTS`) reads `available: true, count: 0` for the runs
it stopped capturing.

Scope is the **workspace**, which is wider than the task surface's `loadScopedRun` on purpose: a
service frame's blueprint run and a recurring bug-intake fire are exactly the runs someone asks
about, and a debugger that cannot see the run that failed is useless. A run outside the key's
workspace is a `404`, indistinguishable from one that never existed.

## The one thing the endpoint table cannot say

The endpoints are listed on the site. The rule a change here must preserve is why the tool-call list
is served in two ORDERS rather than letting the caller sort:

**`trajectory` is not derivable from a `recent` page.** `seq` restarts at zero on every dispatch, and
`jobId` is a string, so ordering by it sorts a run's dispatches by agent-kind spelling and its
re-runs `-10` before `-2`. The server orders by when each call actually STARTED, with `seq`
separating the calls that share a millisecond. A `trajectory` page is therefore a bounded PREFIX and
returns `nextCursor: null`; supplying a cursor with it is a `400` rather than a silent fall back to
the other order, because a caller who thinks they are walking the trajectory and is walking the
keyset gets a plausible wrong answer.

The two point reads are addressed by the row's **own** id rather than nested under the run: the list
already handed the caller that id, and nesting would let a mismatched pair form a request that looks
well-typed and 404s for a reason the caller cannot see.

That same list is the one returning rows WHOLE, bodies included, and it can do so under the size rule
only because a tool call's `args`/`result` are capped at CAPTURE time rather than stored unbounded
and windowed at read time. A change that stores them unbounded silently breaks the size guarantee.

## What the signals are, and what they may not become

The playbook is the site's. Two properties of the signal set are design decisions a change here would
undo:

- **A signal is an OBSERVATION, never a verdict.** They are ordered most-severe first and each
  carries a count, and none of them names a cause. A wrong confident cause is worse than an ordered
  list of facts, and the caller is routinely a model that will repeat whatever it is told.
- **Severity is chosen by how often a healthy run trips it.** `tool_calls_failed` is an `info`
  because a failing tool call is the ordinary shape of an agent loop; as a `warning` it would fire on
  most healthy runs and cost the ordering the thing it is for. `tool_retry_loop` is the `warning`,
  and it considers EVERY `(agentKind, tool)` cell rather than the run's most-failed one, or a fixer
  wedged 5-for-5 on `apply_patch` goes unreported behind a coder's 6 failures across 100 healthy
  `bash` calls.

`failure_outside_model_calls` is the one computed off a sink's ABSENCE as much as its contents: it
fires when the run died while every model call reports `ok`, and its message distinguishes failing
tool calls, a clean recorded loop (so what is left is the engine), and no trajectory at all. Keeping
those three apart is the whole value; collapsing them yields a signal that says "something else".

## Sizing, and the limits

The per-read worst cases, the ceilings and the caller-facing limitations are on the site's
[Sizing a request](https://www.catfactory.ai/operate/debugging-a-run.html#sizing-a-request) and
[Known limitations](https://www.catfactory.ai/operate/debugging-a-run.html#known-limitations). Two of those
limitations are obligations on code here rather than on a caller:

- **Capture gates act UPSTREAM and this surface cannot see them.** `LLM_RECORD_PROMPTS` and the
  per-workspace `storeAgentContext` govern whether text exists at all, so an opted-out workspace
  reads as `available: true, count: 0`. That is honest and it is not the same as empty; anything new
  reporting availability here answers the repository-presence question, never the capture question.
- **Search case folding is ASCII**, because SQLite's `LIKE` folds only ASCII while Postgres' `ILIKE`
  follows its locale. Conformance pins the ASCII behaviour the two stores share, so a store that
  starts folding more widely fails a test rather than making the two runtimes answer differently.

## Where it lives

- Wire contracts: `backend/packages/contracts/src/debug-api.ts` (+ `routes/debug-api.ts`)
- HTTP: `backend/packages/server/src/modules/publicApi/PublicDebugController.ts`
- Reads + projections: `backend/packages/orchestration/src/modules/debug/`
  (`RunDebugService.ts`, `debug.logic.ts`, `promptMessages.ts`)
- Ports: kernel `llm-metrics.ts`, `agent-context.ts`, `agent-search-queries.ts`,
  `agent-tool-calls.ts`,
  `provisioning-log-repositories.ts`, and `ExecutionRepository.listRecent`
- Stores: `D1*` under `backend/runtimes/cloudflare/src/infrastructure/repositories/` ⇄ Drizzle
  under `backend/runtimes/node/src/repositories/drizzle/` ⇄ the local `node:sqlite` telemetry
  store, `backend/runtimes/local/src/sqlite/telemetryStore.ts` (mothership mode; see below)

Cross-runtime parity is pinned twice: the per-store suites
(`llm-metrics-suite`, `agent-context-suite`, `agent-search-queries-suite`,
`agent-tool-calls-suite`, `provisioning-log-suite`) drive the real SQL on both runtimes, including the search predicate,
the match offsets (in code points, against astral-plane characters) and the offset windows, and
`suites/integration-public-debug.ts` drives the HTTP surface end to end and asserts every sink
reads `available: true` on the conformance facades (all of which wire the stores), so a facade
that mounts the routes but forgets a telemetry repository fails there rather than shipping a
surface that reports the sink as unavailable.

## Mothership mode

The run index (`ExecutionRepository.listRecent`) is allow-listed on the machine RPC: runs are
org/durable state and live on the mothership. The **telemetry** reads are not, and must not be:
telemetry is local-first by design, so a mothership-mode node serves every bounded page from its own
`node:sqlite` telemetry store, which mirrors the D1 SQL down to the body slicing, the `?contains=`
and `?phase=` predicates and the match offsets. Routing a page over a long run through the persistence proxy is
exactly the bulk read that bucket exists to forbid. Adding a read here therefore means adding it to
THREE stores, and classifying it `telemetry` in the drift guard's map
(`runtimes/node/test/mothership-allowlist.spec.ts`).

A page the node's own store cannot answer falls through to `POST /internal/telemetry/read`, the
mothership-mode READ-THROUGH: its own machine-authed endpoint with its own CLOSED table of
per-method-bounded reads, never the persistence proxy (whose registry resolves a repository whole,
writes included). So a run whose local rows were pruned, or that another node drove entirely,
still pages here, and a mothership that cannot answer produces a FAILED request rather than an
empty page, which on this surface would read as a run that captured nothing. A run the prune took
only PART of falls through too: the local store records what it deleted, because a surviving suffix
answered as the whole run is the same false picture with rows in it. A read added to the three
stores is worth adding to that table too, or it works locally and stops at the seam. See
[`docs/initiatives/mothership-mode.md`](../../docs/initiatives/mothership-mode.md).
