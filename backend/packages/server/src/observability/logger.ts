import pino from 'pino'
import {
  type LogFields,
  type LogLevel,
  type LogSink,
  type LogThreshold,
  type Logger,
  noopLogger,
} from '@cat-factory/kernel'

// The one place a logging library is named. Everything else in the backend — controllers,
// facades, and the whole domain engine — talks to the kernel `Logger` port, so swapping
// pino out or adding a second destination is a change here and nowhere else.
//
// The default pino transport relies on Node worker threads, which workerd doesn't provide,
// so the Worker bundle resolves pino's BROWSER build; the `browser.write` map below hands
// each level's already-serialised log object to the matching `console` method. A Node
// process takes pino's normal stdout path and never calls those writers at all. Both
// Cloudflare (via `wrangler tail` / Logpush) and a Node process capture the result, so
// either runtime yields queryable, level-routed structured logs.
//
// The writers emit pino's own object VERBATIM (numeric `level`, epoch `time`, `msg`, then
// the bound + call-site fields) rather than a hand-built envelope, so a Worker line and a
// Node line parse identically — only the console method differs.

const LEVEL_RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 }

/**
 * The gate's rank for each threshold. `silent` sits above every emit rank, so the comparison
 * below drops all four levels without needing a second branch. Separate from `LEVEL_RANK`
 * because that one ranks a LINE and this one ranks the GATE; see kernel's `LogThreshold`.
 */
const THRESHOLD_RANK: Record<LogThreshold, number> = {
  ...LEVEL_RANK,
  silent: Number.POSITIVE_INFINITY,
}

/**
 * The active threshold. Held here rather than on the pino instance because a facade
 * resolves `LOG_LEVEL` from its own config *after* module load (a Worker reads it off
 * `env` on the first request), and pino's child loggers snapshot their parent's level at
 * creation — so a late `logger.level = …` would silently miss every child already derived.
 * One module-level check is dynamic by construction.
 */
let activeLevel: LogThreshold = 'info'

/**
 * Parse a configured level, falling back to `info` for an absent or unrecognised value.
 *
 * Returns a `LogLevel`, not a `LogThreshold`: `LOG_LEVEL=silent` is deliberately NOT
 * honoured, so a deployment can never be talked into emitting nothing (see `LogThreshold`).
 * A test suite silences the gate by calling `setLogLevel('silent')` directly.
 */
export function parseLogLevel(value: string | undefined | null): LogLevel {
  const normalized = value?.trim().toLowerCase()
  if (
    normalized === 'debug' ||
    normalized === 'info' ||
    normalized === 'warn' ||
    normalized === 'error'
  ) {
    return normalized
  }
  return 'info'
}

/**
 * Set the emit threshold. Facades call this once at boot from their resolved config
 * (`LOG_LEVEL` in the Node/local env, a wrangler var on the Worker). Takes effect
 * immediately for every logger already handed out, including children.
 *
 * Accepts `silent`, which no `LOG_LEVEL` value parses to: that is the seam a package's
 * vitest `setupFiles` uses to keep a green run's transcript to its assertions instead of
 * the application's own lines.
 */
export function setLogLevel(level: LogThreshold): void {
  activeLevel = level
}

/** The active threshold, for a facade that wants to report its own configuration. */
export function getLogLevel(): LogThreshold {
  return activeLevel
}

/**
 * The optional SECOND destination every emitted line is copied to (today: the opt-in OTLP log
 * exporter). Module state for the same reason `activeLevel` is: a facade wires it from its
 * resolved config after this module has already handed loggers out, and pino children snapshot
 * their parent, so the fan-out has to be looked up per line rather than baked into an instance.
 *
 * Held here because this file is the one place a destination is named at all: the rule that
 * makes "add a second destination" a change in this module and nowhere else.
 */
let activeSink: LogSink | null = null

/**
 * Install (or with `null`, remove) the second destination. Takes effect immediately for every
 * logger already handed out, including children. A facade that installs one owns flushing and
 * removing it: the sink only buffers, so the last lines before shutdown are delivered by the
 * facade's final `flush()`, not by this module.
 */
export function setLogSink(sink: LogSink | null): void {
  activeSink = sink
}

/** The installed second destination, if any. For a facade flushing what it wired. */
export function getLogSink(): LogSink | null {
  return activeSink
}

/**
 * Copy one line to the installed sink, with the `child`-bound fields already folded in.
 *
 * Wrapped, because the port promises a logger cannot fail and a sink is third-party-shaped
 * code on the emit path of every line: a throwing `record` would turn `logger.warn(…)` into a
 * new failure class exactly where a caller is already handling one. The swallow is silent by
 * necessity, because reporting it would emit a line, which would call the sink that just threw.
 */
function fanOut(level: LogLevel, msg: string, fields: LogFields): void {
  const sink = activeSink
  if (!sink) return
  try {
    sink.record({ level, msg, fields, timeMs: Date.now() })
  } catch {
    // silent-catch-ok: see above. The only channel available to report a broken log sink is
    // the log sink. The local writer has the line either way, which is what an operator reads.
  }
}

/**
 * Serialise one log object, never throwing. The port promises a logger cannot fail
 * (`kernel/ports/logging.ts`), and a plain `JSON.stringify` breaks that promise on the Worker:
 * a circular field bag or a `BigInt` raises a `TypeError` straight out of the `logger.warn(…)`
 * call, turning observability into the new failure class the port exists to rule out. The Node
 * path never reaches here — pino serialises with its own cycle-safe stringifier — so this is
 * specifically the browser-build writer's obligation.
 *
 * A field bag we cannot render degrades to a line that still carries the message and names the
 * problem, because a dropped line is indistinguishable from a code path that never ran.
 */
export function serialize(o: object): string {
  try {
    return JSON.stringify(o)
  } catch (error) {
    const msg = (o as { msg?: unknown }).msg
    return JSON.stringify({
      ...(typeof msg === 'string' ? { msg } : {}),
      logSerializationError: error instanceof Error ? error.message : String(error),
    })
  }
}

function write(level: LogLevel): (o: object) => void {
  return (o: object) => {
    const line = serialize(o)
    if (level === 'error') console.error(line)
    else if (level === 'warn') console.warn(line)
    else console.log(line)
  }
}

const PINO_OPTIONS = {
  // pino itself never filters: `activeLevel` above is the gate, so a level configured
  // after boot reaches loggers that were already derived.
  level: 'debug',
  browser: {
    asObject: true,
    write: {
      debug: write('debug'),
      info: write('info'),
      warn: write('warn'),
      error: write('error'),
      // pino's browser shim wants a writer per level; the port exposes no trace/fatal
      // tier, so these only fire if something reaches past the port.
      trace: write('debug'),
      fatal: write('error'),
    },
  },
} as const

type PinoLogger = ReturnType<typeof pino>

/**
 * `bound` mirrors what pino already holds for this instance. Duplicated rather than read back
 * off the instance because the fan-out needs the MERGED bag and pino exposes no accessor for
 * it: a sink that only saw the call-site fields would drop every correlation id bound with
 * `child`, which is the half a line is joined to a run by (`createRecordingLogger` folds them
 * for the same reason).
 */
function adapt(instance: PinoLogger, bound: LogFields = {}): Logger {
  const emit =
    (level: LogLevel) =>
    (msg: string, fields?: LogFields): void => {
      if (LEVEL_RANK[level] < THRESHOLD_RANK[activeLevel]) return
      instance[level](fields ?? {}, msg)
      // The threshold is applied ABOVE this: an exporter ships what the deployment chose to
      // log, so `LOG_LEVEL` governs both destinations and an operator has one dial, not two.
      // A fresh bag per line, never `bound` itself: a sink holds what it is handed (this one
      // buffers it until a flush), and handing over the logger's own object would let it be
      // mutated under every future line of the scope.
      if (activeSink) fanOut(level, msg, { ...bound, ...fields })
    }
  return {
    debug: emit('debug'),
    info: emit('info'),
    warn: emit('warn'),
    error: emit('error'),
    child: (extra) => adapt(instance.child(extra), { ...bound, ...extra }),
  }
}

/**
 * Build a `Logger` over a fresh pino instance. `destination` is a Node-only seam (the browser
 * build the Worker bundles ignores it): pass one to route lines somewhere other than stdout —
 * a file, a capturing stream in a test. Instances built here share the module-level level
 * gate, so they honour `setLogLevel` exactly like the process-wide logger.
 */
export function createPinoLogger(destination?: pino.DestinationStream): Logger {
  return adapt(destination ? pino(PINO_OPTIONS, destination) : pino(PINO_OPTIONS))
}

/**
 * The process-wide logger. Prefer `logger.child({ … })` to attach correlation context —
 * `workspaceId`, `executionId`, `jobId` — so a run can be traced across the request, the
 * workflow and the container. Patterns: `backend/docs/logging.md`.
 */
export const logger: Logger = createPinoLogger()

export { noopLogger }
export type { LogFields, LogLevel, LogSink, LogThreshold, Logger }
