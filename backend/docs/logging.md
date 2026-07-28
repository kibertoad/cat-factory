# Logging

How the platform emits structured logs, and the patterns that keep them useful. The gap analysis
that motivated this — and the remaining slices — live in
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

Message first, fields second — the same shape `@cat-factory/executor-harness` declares for its
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
| A test                                                       | `createRecordingLogger()` from kernel — a `Logger` that records `{ level, msg, fields }` into `.lines` instead of emitting.                                                                                                   |

`CoreDependencies.logger` is optional so a harness can construct a container cheaply;
`resolveCoreRuntime` substitutes `noopLogger` and re-binds it onto the dependency bag, so no
service downstream ever null-checks.

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
fresh isolate can start on any of them). An unrecognised value falls back to `info` — an operator
typo must never silence a deployment.

The threshold is checked in the adapter, not on the pino instance, because pino children snapshot
their parent's level at creation: a facade that configures `LOG_LEVEL` after module load would
otherwise silently miss every logger already handed out.

## Correlation: bind ids once with `child`

A line nobody can tie to a run is nearly worthless. Bind the ids at the top of the scope:

```ts
const log = (opts.log ?? noopLogger).child({ workspaceId, executionId })
```

…rather than re-spreading `{ workspaceId, executionId }` at each call site — which is how a deeply
nested emit (the poll-failure warnings inside `driveExecution`'s `pollUntil`) ends up with no ids
at all. The standard keys are `workspaceId`, `executionId`, `blockId`, `jobId`, plus a `scope` /
`sweep` / `cron` / `runner` tag naming the subsystem.

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
- Do **not** use it when the failure should change the caller's behaviour — that wants a real
  `try`/`catch` with a domain decision.
- Where a bespoke `catch` is right (you need a fallback value, or a different level), still bind
  the cause with `describeError(error)` rather than discarding it.

`describeError` returns `{ err, errKind }` with the message run through `redactSecrets`, because
an error surfaced from `fetch`, a shell spawn or a provider SDK routinely echoes the request URL
(with its query) or an auth header back in its text. It deliberately omits the stack: high volume,
rarely what identifies the failure. Pass one explicitly at a site that needs it.

## Secrets

**Any field that can carry command output, a URL, model text, or a raw error message goes through
`redactSecrets` at the emit site.** `describeError` does this for you. Nothing else does.

Never log an `Authorization` header, a raw query string, a request body, or a decrypted
credential — not even at `debug`. `debug` is a level an operator turns on in production.

## Observability must never break agent work

The rule the PR-verification-report initiative established applies to logging itself: a `Logger`
implementation must not throw, and no fix to a swallow site may let the failure propagate into its
caller. Adding a log line is always safe; changing a `catch` into a rethrow is a behaviour change,
not an observability change.

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

- The message is a fixed string — no interpolated ids, so it groups. Everything variable is a
  field.
- It says what happened AND what the system did about it.
- The fields answer the first question an operator will ask ("which board, which PR, did we at
  least keep attribution?").

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
method — so a Worker line and a Node line parse identically and only the console routing differs.
Cloudflare captures it via `wrangler tail` / Logpush; a Node process writes it to stdout.
