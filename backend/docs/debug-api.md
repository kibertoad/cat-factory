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
request is made.** Five consequences, each visible in the wire contracts
(`@cat-factory/contracts` → `debug-api.ts`):

1. **Every list is keyset-paginated** with a hard `limit` ceiling (100). Cursors are opaque and
   ride the `(createdAt, id)` composite the store orders by — not a bare timestamp, because
   telemetry is written in bursts that share a millisecond and a timestamp-only cursor silently
   drops the ties.
2. **Fan-out lists never carry bodies; bodies are always a point read.** A page of snapshots
   carries sizes (`*Chars`) and identity only. The one opt-in exception is `?bodyChars=` on the
   LLM-call list, because "did this call come back empty?" is a triage question a size alone
   answers ambiguously.
3. **Finding is server-side work too.** The LLM-call list takes a `?contains=` body search
   applied as SQL `LIKE`, so locating a known marker across thousands of calls costs one request
   — paging every body through the caller's own context to grep it there would be the
   multi-hundred-megabyte dump re-entering through the side door. Matched rows report **where**
   the match sits (`matchOffset`), which feeds the point read's window directly. Every other
   narrowing (`?agentKind=`, `?phase=`, `?outcome=`) is SQL for the same reason: a filter applied
   after the read has already paid for the rows it throws away, and it spends the page's `limit`
   on them.
4. **Truncation is reported, never silent, and every slice knows its place.** Every body is a
   `debugText`: `{ text, chars, offset, totalChars, truncated }`. A bare truncated string reads
   exactly like a short one, so a model would confidently report "the agent said nothing" from a
   payload that merely hit its budget — and a slice that didn't state its `offset` could not be
   stitched against its neighbours.
5. **The overview is a map, not a dump.** `GET /debug/runs/:runId` costs a handful of SQL
   aggregates and reads no body at all. Its `sinks` block says which of the four detail endpoints
   have anything in them, so the expensive reads are only issued for data that exists.

Slicing, filtering **and searching** happen in SQL (`substr` / `length` / `instr` / the outcome
predicate), so an un-previewed page does not read the text columns out of the store at all, and a
searched page spends its `limit` on matches only.

## Why the path is `/debug`

Considered against the more resource-oriented alternatives and kept deliberately:

- **Not `/api/v1/runs/:id/…`** — that prefix belongs to the task-scoped public surface
  (`PublicDecisionController`), which resolves runs through the narrower `loadScopedRun`. Mounting
  reads with a _different_ (workspace-wide) authorization rule under the same resource path would
  put two access semantics behind one name, which is a trap for both callers and reviewers.
- **Not `/observability` or `/telemetry`** — those name the _capture_ subsystems, and this surface
  is neither: the run index and the provisioning log are not telemetry, and what is served here
  is a purpose-built diagnostic **projection** (budgeted slices, derived signals, availability
  flags), not the canonical stores.
- `/debug` names the caller's intent — the same way `/search` does on APIs that serve
  purpose-shaped projections — and it is short in every one of the many tool calls an LLM caller
  makes. The resources under it are still nouns (`runs`, `llm-calls`, `agent-context`); the
  namespace states what they are _for_.

## Auth

`Authorization: Bearer cf_live_…` — a public-API key, resolved to its workspace exactly like the
rest of `/api/v1` (see [`PublicApiController`](../packages/server/src/modules/publicApi/PublicApiController.ts)).
The whole surface needs the **`read`** rung of the scope ladder. How keys are minted and the rest
of the `/api/v1` surface: [`public-api.md`](./public-api.md).

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

| Method / path                                  | Returns                                                                                                                    |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/v1/debug/runs`                       | The workspace's runs, newest first. `?status=`, `?since=`, `?limit=`, `?cursor=`                                           |
| `GET /api/v1/debug/runs/:runId`                | The run's diagnostic **overview** (aggregates + signals)                                                                   |
| `GET /api/v1/debug/runs/:runId/llm-calls`      | Recorded model calls. `?agentKind=`, `?phase=`, `?outcome=`, `?contains=`, `?order=`, `?bodyChars=`, `?limit=`, `?cursor=` |
| `GET /api/v1/debug/llm-calls/:callId`          | One call, full bodies. `?bodyChars=`, `?bodyOffset=`, `?view=raw\|messages`                                                |
| `GET /api/v1/debug/runs/:runId/agent-context`  | Captured dispatches, **sizes only**. `?stepIndex=`, `?limit=`, `?cursor=`                                                  |
| `GET /api/v1/debug/agent-context/:snapshotId`  | One dispatch's prompts, fragments, injected files. `?bodyChars=`, `?bodyOffset=`                                           |
| `GET /api/v1/debug/runs/:runId/search-queries` | Web searches the run's agents performed                                                                                    |
| `GET /api/v1/debug/runs/:runId/logs`           | The run's provisioning event log                                                                                           |

The two point reads are addressed by the row's **own** id rather than nested under the run: the
list already handed the caller that id, and nesting would let a mismatched pair form a request that
looks well-typed and 404s for a reason the caller cannot see.

## Investigating a run

### 1. Find it, map it

`GET /debug/runs?status=failed` finds the run; `GET /debug/runs/:runId` maps it. Read `signals`
first: they are precomputed derivations (failed calls, truncated output per agent kind, container
evictions, provisioning failures, a cold prompt cache), ordered most-severe first, each with a
`count`. A model that has to rediscover "13 of 40 calls were truncated" by arithmetic over a JSON
blob will sometimes get it wrong and will always spend context getting it right. Signals are
observations, never a verdict — a wrong confident cause is worse than an ordered list of facts.

### 2. Follow the signal

The failure classes and where each one's evidence lives:

- **`provisioning_failed` — infrastructure.** `/logs` holds the verbatim (scrubbed) provider
  error. For a run whose container never came up there is no model telemetry at all, and this is
  the only place its cause of death is written. The overview's per-step `firstEvictionDetail`
  (exit state + a log tail) covers a container that came up and then died.
- **`llm_calls_failed` — the model side broke.** `/llm-calls?outcome=error`, then the point read
  for the bodies. Non-2xx statuses and error messages here mean transport, proxy, or spend-gate
  trouble — an infrastructure problem wearing model clothes.
- **`output_truncated` — the model was cut off.** The per-kind insight names which agent kept
  hitting its output ceiling (`outputHeadroomRatio` ≈ 1). The fix conversation is about output
  limits or task size, not correctness.
- **`failure_outside_model_calls` — the run died while every call looks healthy.** This is the
  most common hard diagnosis, and it has no row of its own: tool-EXECUTION errors (malformed
  arguments, a stuck edit loop) happen inside the container and exist only as text inside the
  prompt deltas — each call still reports `ok` with a clean finish reason. The signal points at
  the search workflow below.
- **`prompt_cache_cold` / a cost question.** The overview's `llm.totals` and `byAgentKind` carry
  the three input classes (fresh / cache read / cache write) separately — a loop that keeps
  invalidating its prefix and one riding a warm cache are indistinguishable when they are summed.
- **"why did this small task cost so much?" — read `llm.byPhase`.** It re-cuts the same aggregate
  by WHICH slice of the run's work spent the tokens (the agent's own edit loop, a pre-PR
  validation repair round, a reproduction-proof repair round, …), which `byAgentKind` cannot
  answer because one coder step contains every phase. Rows lead with `carryCostTokens` — each
  call's context counted once for every later turn in its conversation that had to re-send it —
  so the phase that made everything after it expensive sorts first, not merely the one that read
  the most. Compare a run's phases against each other; the absolute number means nothing.
  `phase: ""` is the unattributed slice (an older harness image, an inline call, the un-phased
  proxy path) and is always present rather than dropped, so "we could not attribute this" never
  reads as "nothing was spent here". `/llm-calls?phase=` drills into any row, `""` included.

### 3. Grep for the cause (`?contains=`)

When the model side looks healthy, the cause is almost always _in the text_. Search for it
server-side instead of paging bodies:

```
GET /debug/runs/:runId/llm-calls?contains=Validation%20failed&order=oldest
```

`contains` matches the prompt delta, response and reasoning case-insensitively in SQL (`%`/`_`
match literally), so one request finds the needle across thousands of calls. Markers that have
repeatedly paid off:

- `Validation failed for tool` / `must have required properties` — the model is emitting
  malformed tool arguments; if it keeps repeating after the error is fed back, that is a
  model-quality problem, not a prompt problem.
- A distinctive fragment of the run's `failure.message` — finds the call where the terminal
  symptom first appears.
- `<tool_call>` in **responses** — the model emitted a tool call as prose instead of through the
  structured channel.
- A file path, test name, or error string from the task — finds where the agent first met it.

Each matched row reports a per-body `matchOffset` (null = the term is in a sibling body, not this
one). Feed it to the point read to see the context **around** the match — the `grep -C` of this
surface:

```
GET /debug/llm-calls/:callId?bodyOffset=<matchOffset - 500>&bodyChars=2000
```

`bodyOffset` windows the body from any position, so the middle and the tail of a large body are
reachable — the last tool result in a long delta and the end of a captured build log are exactly
where causes sit. Every slice states the `offset` it starts at, so neighbouring windows stitch.

### 3b. Attribute the spend (`?phase=`)

Every call row carries `phase` — WHICH slice of the run paid for it: the agent's own edit loop
(`agent`), a pre-PR validation repair round (`validation-repair`), a reproduction-proof repair
round (`reproduction-repair`), … — plus `turnIndex`, its ordinal within that job's telemetry
sequence. Both are stamped by whoever owns the loop boundary, so they are read rather than inferred;
reconstructing either from wall-clock timestamps is the brittle guess they exist to replace.

`?phase=validation-repair` narrows the page in SQL, which is what makes "the pipeline did work this
task never needed" answerable in one request instead of by paging the whole run and grouping
client-side.

Two values behave in ways worth knowing before you read a number off this:

- **`phase=` (empty) is a real query**, selecting the UNATTRIBUTED slice — an older harness image,
  an inline call, or the un-phased proxy path. It is not "no filter". A run whose calls are all
  unattributed was metered by a channel with no phase concept; it did **not** spend nothing outside
  the agent loop. An INLINE call (a judge, consensus, the requirements writer, an inline agent kind
  such as `doc-researcher` / `doc-outliner` / the document interviewer) always lands here: phases
  are boundaries the container harness owns, so a call made outside a container has none to claim.
  It is recognisable by the company it keeps — `turnIndex` null, `httpStatus` null,
  `upstreamMs === totalMs`. So a run built entirely of inline steps reports its whole spend under
  `phase=""`, which is a complete answer rather than a missing one.
- **`turnIndex` is `null`**, not 0, wherever the producing channel has no turn concept (the LLM
  proxy sees one HTTP request at a time with no job-scoped counter). A 0 there would read as "the
  first turn" and sort every proxied call to the front of its phase.

### 4. Read the conversation

`GET /debug/runs/:runId/llm-calls?agentKind=coder&order=oldest&bodyChars=2000` walks one agent
kind's conversation forwards. Each call's `prompt` is the **delta** — only the messages that call
appended — because that is how the store keeps prompts (a container agent re-sends its whole
growing history every turn, so storing the full array per call is ~21× redundant). Concatenating
the deltas in order reconstructs the conversation, and `elidedLeadingMessages` says how many
earlier messages the delta sits on top of. That shape is also why the API never re-sends the shared
prefix to the caller either.

For one call, `?view=messages` on the point read parses the delta into per-message rows (role,
tool name, tool calls with their arguments, content), each budgeted **independently** via
`bodyChars`. In the raw view a 100 kB leading tool result must be paid for in full before anything
after it is visible; in the messages view every message shows its head. An unparseable delta
degrades to the raw window with `promptMessages: null` — stated, never guessed at.

## Sizing a request

A page's worst case is `limit × 3 × bodyChars` characters of body for the LLM-call list, and
`limit × <row size>` for everything else (agent-context index rows carry no body; search and log
rows are small by construction). A `?view=messages` point read's worst case is
`(messageCount − elidedLeadingMessages) × bodyChars` — both factors already on the list row.
Ceilings: `limit ≤ 100`, `bodyChars ≤ 4 000` on a list and `≤ 200 000` on a point read,
`bodyOffset ≤ 2 000 000` (above the store's own 512 kB per-body cap, so with `?bodyOffset=` every
stored character is reachable — a body larger than one window is read in stitched windows, and
`truncated`/`offset`/`totalChars` always say which part is in hand).

## Known limitations

- **A conversation is identified by `agentKind`, not by step.** The call rows carry no step
  index, so a step re-dispatched after an eviction — or repeated fixer attempts — interleaves
  into one "conversation". A chain restart is visible as `elidedLeadingMessages` dropping back to
  0 partway through an `order=oldest` walk, and `turnIndex` resetting is the same signal from the
  other side (it is the harness's JOB-scoped counter, so a re-dispatch starts it over). Neither is
  a step index: they mark the boundary without naming which attempt sits on either side of it, and
  a proxied call reports `turnIndex: null` rather than participating in the sequence at all.
- **Tool-execution errors are not rows.** The harness's tool loop runs inside the container; its
  failures reach this surface only as text inside prompt deltas. The
  `failure_outside_model_calls` signal and `?contains=` exist precisely to compensate; a
  first-class per-call tool-error count would need harness capture (an image-bumping change) and
  is deliberately not faked here from pattern-matching at record time.
- **Search case folding is ASCII.** SQLite's `LIKE` folds only ASCII and Postgres' `ILIKE`
  follows its locale; conformance pins the ASCII behaviour the two stores share. Search terms are
  literal substrings, not patterns.
- **Capture gates act upstream.** `LLM_RECORD_PROMPTS` and `storeAgentContext` govern what text
  exists at all; this surface cannot see them and reports `available: true, count: 0` for a
  workspace that opted out.

## Where it lives

- Wire contracts: `backend/packages/contracts/src/debug-api.ts` (+ `routes/debug-api.ts`)
- HTTP: `backend/packages/server/src/modules/publicApi/PublicDebugController.ts`
- Reads + projections: `backend/packages/orchestration/src/modules/debug/`
  (`RunDebugService.ts`, `debug.logic.ts`, `promptMessages.ts`)
- Ports: kernel `llm-metrics.ts`, `agent-context.ts`, `agent-search-queries.ts`,
  `provisioning-log-repositories.ts`, and `ExecutionRepository.listRecent`
- Stores: `D1*` under `backend/runtimes/cloudflare/src/infrastructure/repositories/` ⇄ Drizzle
  under `backend/runtimes/node/src/repositories/drizzle/` ⇄ the local `node:sqlite` telemetry
  store, `backend/runtimes/local/src/sqlite/telemetryStore.ts` (mothership mode — see below)

Cross-runtime parity is pinned twice: the per-store suites
(`llm-metrics-suite`, `agent-context-suite`, `agent-search-queries-suite`,
`provisioning-log-suite`) drive the real SQL on both runtimes — including the search predicate,
the match offsets (in code points, against astral-plane characters) and the offset windows — and
`suites/integration-public-debug.ts` drives the HTTP surface end to end and asserts every sink
reads `available: true` on the conformance facades (all of which wire the stores) — so a facade
that mounts the routes but forgets a telemetry repository fails there rather than shipping a
surface that reports the sink as unavailable.

## Mothership mode

The run index (`ExecutionRepository.listRecent`) is allow-listed on the machine RPC — runs are
org/durable state and live on the mothership. The **telemetry** reads are not, and must not be:
telemetry is local-first by design, so a mothership-mode node serves every bounded page from its own
`node:sqlite` telemetry store, which mirrors the D1 SQL down to the body slicing, the `?contains=`
and `?phase=` predicates and the match offsets. Routing a page over a long run through the persistence proxy is
exactly the bulk read that bucket exists to forbid. Adding a read here therefore means adding it to
THREE stores, and classifying it `telemetry` in the drift guard's map
(`runtimes/node/test/mothership-allowlist.spec.ts`). See
[`docs/initiatives/mothership-mode.md`](../../docs/initiatives/mothership-mode.md).
