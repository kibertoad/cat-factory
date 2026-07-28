import pino from 'pino'
import { type LogFields, type LogLevel, type Logger, noopLogger } from '@cat-factory/kernel'

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
 * The active threshold. Held here rather than on the pino instance because a facade
 * resolves `LOG_LEVEL` from its own config *after* module load (a Worker reads it off
 * `env` on the first request), and pino's child loggers snapshot their parent's level at
 * creation — so a late `logger.level = …` would silently miss every child already derived.
 * One module-level check is dynamic by construction.
 */
let activeLevel: LogLevel = 'info'

/** Parse a configured level, falling back to `info` for an absent or unrecognised value. */
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
 */
export function setLogLevel(level: LogLevel): void {
  activeLevel = level
}

/** The active threshold, for a facade that wants to report its own configuration. */
export function getLogLevel(): LogLevel {
  return activeLevel
}

function write(level: LogLevel): (o: object) => void {
  return (o: object) => {
    const line = JSON.stringify(o)
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

function adapt(instance: PinoLogger): Logger {
  const emit =
    (level: LogLevel) =>
    (msg: string, fields?: LogFields): void => {
      if (LEVEL_RANK[level] < LEVEL_RANK[activeLevel]) return
      instance[level](fields ?? {}, msg)
    }
  return {
    debug: emit('debug'),
    info: emit('info'),
    warn: emit('warn'),
    error: emit('error'),
    child: (bound) => adapt(instance.child(bound)),
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
export type { LogFields, LogLevel, Logger }
