# Logging

How the platform emits structured logs, and the patterns that keep them useful. The gap analysis
that motivated this, and the remaining slices, live in
[`docs/initiatives/observability-logging-gaps.md`](../../docs/initiatives/observability-logging-gaps.md).

## The shape

One interface, everywhere: the kernel `Logger` port (`kernel/src/ports/logging.ts`).

```ts
interface Logger {
  debug(msg: string, fields?: LogFields): void
  info(msg: string, fields?: LogFields): void
  warn(msg: string, fields?: LogFields): void
  error(msg: string, fields?: LogFields): void
  child(bound: LogFields): Logger
}
```

Message first, fields second: the same shape `@cat-factory/executor-harness` declares for its
zero-dependency logger, so one calling convention covers the backend and the container payload.
It is a **port**, injected like `Clock`/`IdGenerator`, which is what lets `orchestration`,
`integrations`, `agents` and `kernel` log at all: they must not import a runtime facade, and
before the port existed the ~113k LOC of domain logic was silent by construction.

`@cat-factory/server`'s `observability/logger.ts` is the **only** place a logging library is
named. It adapts pino onto the port and exports the process-wide `logger`. Swapping pino out, or
adding a second destination, is a change there and nowhere else.

There is deliberately **no `trace` or `fatal` tier**. Four levels is the whole vocabulary.

### Do NOT declare your own logger interface

A local `interface XLogger { warn(obj, msg?): void }` was the pre-port stopgap. Every one of them
has been retired. Depend on the kernel `Logger`; if your package can't see kernel, it is in the
wrong layer.

## Getting a logger

| Where you are                                                | How you get one                                                                                                                                                                                                               |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A domain service (orchestration / integrations / agents)     | A `logger?: Logger` dependency, normalised once in the constructor: `this.log = deps.logger ?? noopLogger`. `createCore` always injects the facade's real instance, so `noopLogger` only ever applies to a test or a harness. |
| A shared controller / runtime helper (`@cat-factory/server`) | `import { logger } from '../observability/logger.js'`                                                                                                                                                                         |
| A facade (`runtimes/*`)                                      | `import { logger } from '@cat-factory/server'`, or `container.logger` when you want the same instance the domain services got.                                                                                                |
| A test                                                       | `createRecordingLogger()` from kernel: a `Logger` that records `{ level, msg, fields }` into `.lines` instead of emitting.                                                                                                    |

**`CoreDependencies.logger` is REQUIRED**, so a facade that forgets to wire it fails to typecheck.
That is not incidental strictness: it was optional first, and the Worker's dependency literal
simply had no `logger` key; every domain service on the deployed runtime silently fell back to
`noopLogger`, and nothing anywhere said so. A test or harness that does not care passes
`noopLogger` explicitly, which costs one line and cannot happen by accident.

## Levels

| Level   | Use it for                                                                      | Rule of thumb                                                                                                                                              |
| ------- | ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `debug` | Verbose diagnostics an operator turns ON during an incident. Off by default.    | Safe to be chatty. The swallowed-by-design paths that fire constantly on the healthy path (`WorkflowsWorkRunner`'s "instance already exists") belong here. |
| `info`  | A lifecycle transition worth seeing in a HEALTHY deployment.                    | If it fires per row or per poll, it isn't `info`.                                                                                                          |
| `warn`  | Something degraded but handled. **The canonical level for a best-effort drop.** | The work continues; a human might want to know.                                                                                                            |
| `error` | Work was lost, or a request failed unexpectedly.                                | Someone should look.                                                                                                                                       |

`LOG_LEVEL` sets the threshold: `process.env.LOG_LEVEL` on Node/local (applied in `start` /
`startLocal` before anything else, so a boot failure is logged at the operator's chosen level),
and a `[vars]` entry on the Worker (applied at the top of `fetch`/`scheduled`/`queue`, since a
fresh isolate can start on any of them). An unrecognised value falls back to `info`: an operator
typo must never silence a deployment.

The threshold is checked in the adapter, not on the pino instance, because pino children snapshot
their parent's level at creation: a facade that configures `LOG_LEVEL` after module load would
otherwise silently miss every logger already handed out.

## Correlation: bind ids once with `child`

A line nobody can tie to a run is nearly worthless. Bind the ids at the top of the scope:

```ts
const log = (opts.log ?? noopLogger).child({ workspaceId, executionId })
```

…rather than re-spreading `{ workspaceId, executionId }` at each call site, which is how a deeply
nested emit (the poll-failure warnings inside `driveExecution`'s `pollUntil`) ends up with no ids
at all. The standard keys are `requestId`, `workspaceId`, `executionId`, `blockId`, `jobId`, plus a
`scope` / `sweep` / `cron` / `runner` tag naming the subsystem.

Three seams bind those ids for you, so most code inherits correlation rather than arranging it:

### The request (`mountRequestLogging`)

Both facades mount it FIRST (before CORS, before the per-request container) so nothing that can
produce a response escapes it. It adopts a safe, bounded `X-Request-Id` from the caller or mints
one, echoes it on the response, puts it in **every error envelope**, and binds
`{ requestId, method, path }` onto a request-scoped child logger. Reach that logger from a
controller with `requestLogger(c)`; it falls back to the process-wide one when the middleware
isn't mounted, so no call site branches.

It also **adopts an inbound W3C `traceparent`** when the caller sent one, binding `traceId` and
`spanId` alongside. That is what lets a caller already collecting a distributed trace (an SDK
client, a gateway, a sibling service) see this deployment's lines inside their own trace rather
than beside it. The header is untrusted, so `parseTraceparent` (kernel) admits only the exact
fixed-width hex grammar and refuses the spec's all-zero sentinels; malformed means IGNORED, never
a refused request. Where the OTLP log exporter is wired, a line naming a RUN still takes that
run's derived trace id: see the exporter's README for why that precedence is the load-bearing
half.

One line per request: `info` on success, `warn` on a 4xx (with the `errorCode` `handleError`
mapped, when the refusal came through a thrown `DomainError`), `error` on a 5xx. `/health` and
`/ready` drop to `debug` when they succeed: an orchestrator probes them every few seconds, and a
per-poll line is exactly what the level table above says `info` is not for. The LLM proxy is
deliberately NOT quieted despite being the highest-volume route (one request per model call): a
probe fires when nothing is happening, whereas every proxy line marks real billable work and joins
to an `llm_call_metrics` row. Quiet the idle chatter, never the work.

Only the **pathname** is logged, never the raw URL: a query string routinely carries a token (the
WebSocket `?ticket=`, an OAuth `?code=`), and this value lands in every line for the request. For
the same reason a client-supplied id is refused unless it is short and matches `[\w\-=]+`: it is
attacker-controlled text going straight into a log stream.

`durationMs` is a coarse "was this slow" signal, not a latency measurement. On workerd `Date.now()`
is frozen between I/O operations, so a request performing none reads 0 and every other value snaps
to the last I/O boundary; and for a STREAMED response it covers time-to-headers, because `next()`
resolves when the handler returns the `Response`, not when its body finishes.

The **misconfiguration fallback** mounts it too. The Worker inherits it (it serves the fallback from
inside `createApp`), but Node/local swap in the whole `createMisconfiguredApp`, so it mounts the
middleware itself, or the one deployment shape someone is actively debugging would be the only one
with no ids and no request lines.

### The container (`containerJobLog`)

The workflow↔container seam was the platform's blindest: the durable driver knows a run as
`executionId`, the harness knew it only as `jobId`, and `ContainerAgentExecutor` (the thing that
joins them) logged nothing at all. It now emits one line per lifecycle transition (dispatched /
dispatch-failed / poll-failed / running at `debug` / settled) with
`{ workspaceId, executionId, jobId, agentKind }` bound, and the same two ids ride the **job body**
so the harness binds them onto its own per-job child logger beside `jobId`. A container line and a
backend line for the same run now join on `executionId`.

Every dispatcher of the `agent` kind puts those ids on its body, not just the execution path:
`ContainerRepoBootstrapper` and `ContainerEnvConfigRepairer` hand-build their bodies rather than
going through `buildCommonBody`, and a bootstrap is a first-class agent run. Neither has a separate
execution row, so the job id doubles as the run id (matching the session token they mint).

### The durable driver

`ExecutionWorkflow` / `driveExecution` bind `{ workspaceId, executionId }` at the top of the run.

## Best-effort work: `runBestEffort`, never `.catch(() => {})`

A background write, a tracker echo, a lease release, a notification raise: work whose failure must
NOT propagate into the caller. Keep the swallow; add the evidence.

```ts
await runBestEffort(
  this.log,
  'execution.autoStartDependents',
  () => this.autoStartDependents(workspaceId, blockId),
  { workspaceId, blockId },
)
```

It runs `fn`, swallows any rejection **or synchronous throw**, logs one `warn` naming the
operation with the cause attached, and returns `undefined`. It never rejects.

- Use it when the failure genuinely doesn't change what the caller does.
- Do **not** use it when the failure should change the caller's behaviour: that wants a real
  `try`/`catch` with a domain decision.
- Where a bespoke `catch` is right (you need a fallback value, or a different level), still bind
  the cause with `describeError(error)` rather than discarding it.

`describeError` returns `{ err, errKind }` with the message run through `redactSecrets`, because
an error surfaced from `fetch`, a shell spawn or a provider SDK routinely echoes the request URL
(with its query) or an auth header back in its text. It deliberately omits the stack: high volume,
rarely what identifies the failure. Pass one explicitly at a site that needs it.

### The guard, and the escape hatch

`scripts/check-silent-catch.mjs` (CI's `repo-guards` job) fails on `.catch(() => {})` anywhere in
`backend/packages` or `backend/runtimes` non-test source. It is a script rather than a lint rule
only because oxlint ships no `no-restricted-syntax`: the same reason `check-file-size.mjs` exists
beside `max-lines`.

**Every spelling of an empty handler counts**, not just the canonical one: arrow or `function`,
typed param or not, and (the one worth knowing about) a body holding nothing but a comment.
`.catch(() => { /* ignored */ })` is caught, because otherwise the escape hatch below is optional
in practice: an author can document a swallow inline and never state a reason. What the guard
cannot see is an empty NAMED handler (`.catch(noop)`); whether a function is empty is not a
question a text scan can answer, and guessing would make the guard unpredictable.

The detection lives in `scripts/silent-catch.mjs` with fixtures in `silent-catch.test.mjs`
(`node --test 'scripts/*.test.mjs'`, also a CI step). It works by MASKING every comment and string
literal before matching, rather than matching first and asking "was that a comment?" afterwards:
the earlier heuristic version read the `//` in a URL as the start of a comment, so
`fetch('https://…').catch(() => {})` switched the guard off on the very line it was meant to catch.
If you change the detector, add the case to those fixtures: a guard that regresses silently is
worse than no guard, because it reports green either way.

Not every silent drop is a bug. When the failure genuinely needs no report (the classic case is a
rejection some other path has already observed and reported) keep the idiom and say why on the
line(s) above it:

```ts
// silent-catch-ok: the race above already surfaces this rejection when it lands in time; a
// second report here would warn on every probe timeout for a cause the caller already has.
promise.catch(() => {})
```

The marker requires a reason, so opting out is a sentence a reviewer reads rather than a token they
skim past. Two areas are deliberately out of scope and tracked as their own slices in
[`observability-logging-gaps.md`](../../docs/initiatives/observability-logging-gaps.md): the
executor/deploy harnesses (a source change there bumps the published runner image, so all harness
work batches together) and the SPA (it has no logger to report through until client-side error
reporting lands). A bare `catch {}` isn't checked yet either: there are ~110 in scope, most of them
documented deliberate swallows.

## Secrets

**Any field that can carry command output, a URL, model text, or a raw error message goes through
`redactSecrets` at the emit site.** `describeError` does this for you. Nothing else does.

Never log an `Authorization` header, a raw query string, a request body, or a decrypted
credential, not even at `debug`. `debug` is a level an operator turns on in production.

**Emit-site redaction is an EGRESS boundary, not just a hygiene rule.** With a `LogSink` installed
(below), a field leaves the deployment for a third-party collector rather than stopping at the
operator's own stdout, and it is retained and indexed there. The sink deliberately does not
re-scrub: a second pass at the fan-out would encourage treating the emit site as optional, and it
cannot tell a redacted value from one that never needed redacting. So a missed `redactSecrets` is
now a leak to somebody else's system, which is the reason the rule above says "at the emit site"
and means it.

## Observability must never break agent work

The rule the PR-verification-report initiative established applies to logging itself: a `Logger`
implementation must not throw, and no fix to a swallow site may let the failure propagate into its
caller. Adding a log line is always safe; changing a `catch` into a rethrow is a behaviour change,
not an observability change.

The pino adapter holds up its end: the Worker's writer serialises through a guarded stringify, so
an unserialisable field bag (a cycle, a `BigInt`) degrades to a line carrying the message and a
`logSerializationError` instead of raising a `TypeError` out of the caller's `logger.warn(…)`. A
second `Logger` implementation owes the same guarantee.

The corollary matters just as much: don't create a new class of silent background failure while
building the thing that watches for them.

## What a good line looks like

```ts
this.log.warn('merge classification failed; recording an unclassified row', {
  workspaceId,
  blockId: block.id,
  prNumber,
  attributable: repo !== undefined,
  ...describeError(error),
})
```

- The message is a fixed string, no interpolated ids, so it groups. Everything variable is a
  field.
- It says what happened AND what the system did about it.
- The fields answer the first question an operator will ask ("which board, which PR, did we at
  least keep attribution?").

### Field names to avoid

`msg`, `level` and `time` are the envelope's own keys (see [Output format](#output-format)), so a
field bag carrying one of them collides with the line's own structure rather than adding to it:
silently, since nothing rejects it. Name yours something else (`detail`, `severityHint`,
`observedAt`).

Prefer `...describeError(error)` over hand-rolling an error field. Besides the scrubbing, it keeps
one shape (`err` + `errKind`) across every line in the platform, and it avoids the specific trap of
passing a raw `Error` object: the Worker bundles pino's browser build, which `JSON.stringify`s an
`Error` to `{}`, so the cause vanishes on exactly the runtime you cannot attach a debugger to.

## Testing that something logged

`createRecordingLogger()` is shipped from kernel precisely so a best-effort path's evidence is
assertable:

```ts
const logger = createRecordingLogger()
await service.doBestEffortThing()
expect(logger.lines.filter((l) => l.level === 'warn')).toHaveLength(1)
```

A child logger writes into the SAME `lines` array as its parent, with the bound fields folded in,
so you can assert correlation ids without threading the child back out.

## Output format

pino's own JSON object, verbatim, on both runtimes: numeric `level`, epoch `time`, `msg`, then the
bound and call-site fields. The Worker bundles pino's browser build (workerd has no worker
threads), whose per-level `write` hands the already-serialised object to the matching `console`
method, so a Worker line and a Node line parse identically and only the console routing differs.
Cloudflare captures it via `wrangler tail` / Logpush; a Node process writes it to stdout.

## Shipping lines somewhere: the `LogSink` seam

A deployment can send every emitted line to a second destination as well as to the local writer.
The seam is the kernel **`LogSink`** port (`ports/logging.ts`), installed on the adapter with
`setLogSink(sink)` and today implemented by the opt-in OTLP log exporter
([`@cat-factory/observability-otel`](../packages/observability-otel/README.md#log-export-the-third-signal),
`OTEL_LOGS=true` on top of a configured exporter). Nothing in the domain changes: packages keep
logging through the one `Logger` port, and the fan-out lives in `observability/logger.ts`, which
is exactly what "adding a second destination is a change there and nowhere else" meant.

Four rules bind a new sink, each of them a way the seam could otherwise become a failure class:

- **`record` may not throw and may not block.** It runs inside `logger.warn(…)`, often on a path
  already handling a failure. Buffer and return; do the I/O in `flush`. The adapter wraps the
  call anyway (silently: the only channel available to report a broken log sink is the log sink),
  but a sink that relies on that wrapper is one bad deploy from losing every line.
- **`flush` may not reject**, for the same reason every other best-effort path resolves, and a
  sink must enforce that STRUCTURALLY rather than by having no throwing code. Where sends are
  serialised behind one promise tail (the OTLP exporter's shape), a single escaped rejection is
  not one lost batch: every later send chains onto the rejected tail and inherits it, so the sink
  goes permanently silent, and on Node the flush interval's un-awaited call becomes an unhandled
  rejection that the process failure guards answer by EXITING. Terminate the chain.
- **Whatever a sink does per line must be TOTAL.** `LogFields` is `Record<string, unknown>`, so a
  value can throw on read (an accessor, a Proxy trap) or refuse to serialise. Work done on the
  drain path is past the adapter's wrapper, so it owes its own guards, per field rather than per
  batch: one unreadable value should cost that value, and be reported in place of it.
- **A sink gets the MERGED field bag**, `child`-bound fields folded in, because the correlation
  ids are the half a line is joined to a run by and a sink cannot reconstruct them.
- **The level gate applies first**, so `LOG_LEVEL` governs both destinations. One dial, not two
  that can disagree about what a deployment is emitting.

Draining is the FACADE's job, not the sink's: Node flushes on an interval and once more on
shutdown (after every other stop, so the shutdown's own lines get out), the Worker flushes at the
end of each invocation, because its buffer is per isolate and an isolate is discarded without
notice. A sink that started its own timer would be making a promise workerd cannot keep.

The shutdown flush is **bounded** (5s). A full buffer drains as sequential POSTs that each carry
the transport's own timeout, so an unbounded final flush can outlast the SIGTERM grace period a
supervisor allows and be SIGKILLed, losing the shutdown lines it exists to deliver along with
every other stop's. When the deadline fires it says so, because lines were left undelivered.

## Logging is half of it: count the event too

A log line answers "what happened to THIS run". It cannot answer "is this happening more than it
was", and that second question is the one an operator asks during an incident. A deployment where
every container is being evicted produces a steady trickle of individual `warn` lines and no signal
at all that a rate changed.

So the operational events go through kernel's `OperationalMetrics` port
(`ports/operational-metrics.ts`) as well as through the logger. The two are siblings by design:

```ts
// The seam is injected like the logger, and required for the same reason.
this.metrics.increment('container.evicted', { kind: view.evicted })
this.log.warn('container job failed', { workspaceId, executionId, jobId, evicted: view.evicted })
```

Three rules bind a new increment site, and they are the reason the two are not one call:

- **The counter's dimensions must be BOUNDED**; the log line's fields need not be. Every distinct
  dimension value is its own metric time series in the operator's backend, so `{ kind: 'crash' }`
  belongs on the counter and `{ executionId, jobId }` belongs on the line. Putting a run id on a
  counter is a cardinality explosion that costs money and eventually gets the series dropped.
- **Counters are DELTAS, flushed by whoever holds them.** The collector is per process on Node and
  per ISOLATE on the Worker; each flush reports only what it saw, which is exactly why it sums
  correctly across however many flushers there are.
- **An un-wired counter is indistinguishable from an event that never happened.** That is why
  `CoreDependencies.operationalMetrics` and `SweeperOptions.metrics` are REQUIRED rather than
  optional: the same call, for the same reason, as `CoreDependencies.logger`. A caller with
  nothing to export passes `noopOperationalMetrics` explicitly.

Adding a signal means adding a member to the closed `OperationalCounter` / `OperationalGauge`
union in kernel; the OTel mapping names every member through an exhaustive `Record`, so it fails
to compile until the new one has a metric name and a unit.

`createOperationalMetricsCollector()` is the assertable fake, the way `createRecordingLogger()` is
for lines:

```ts
const metrics = createOperationalMetricsCollector()
await service.doThing()
expect(metrics.drain()).toContainEqual({
  counter: 'container.evicted',
  dimensions: { kind: 'crash' },
  value: 1,
})
```
