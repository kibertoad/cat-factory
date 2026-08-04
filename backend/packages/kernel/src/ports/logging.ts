// The logging port. Injected like `Clock`/`IdGenerator` rather than imported, so the
// domain packages (orchestration, integrations, agents, kernel itself) can emit
// structured lines without depending on a runtime facade or on `@cat-factory/server`.
//
// The shape is deliberately message-first with a trailing field bag — the same interface
// `@cat-factory/executor-harness` declares for its zero-dependency logger — so one calling
// convention covers the backend and the container payload. `@cat-factory/server` adapts
// pino onto it (`createPinoLogger`), which is the only place a logging library is named.

/** Structured fields attached to one line. Values are JSON-serialised by the implementation. */
export type LogFields = Record<string, unknown>

/** The levels the platform emits. There is deliberately no `fatal`/`trace` tier. */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

/**
 * The logging surface: four levels plus `child` to bind correlation fields once.
 *
 * Every method is fire-and-forget and MUST NOT throw — a logger that can fail turns
 * observability into a new failure class (see `backend/docs/logging.md`).
 */
export interface Logger {
  /** Verbose diagnostics, off unless `LOG_LEVEL=debug`. Safe to be chatty. */
  debug(msg: string, fields?: LogFields): void
  /** A lifecycle transition worth seeing in a healthy deployment. */
  info(msg: string, fields?: LogFields): void
  /** Something degraded but handled — the canonical level for a best-effort drop. */
  warn(msg: string, fields?: LogFields): void
  /** Work was lost or a request failed. */
  error(msg: string, fields?: LogFields): void
  /**
   * Return a logger that merges `bound` into every line it emits (e.g.
   * `{ workspaceId, executionId }`), so a per-run logger carries its correlation
   * context without each call site re-spreading it. Nestable: the returned logger's
   * own `child` accumulates onto these bound fields.
   */
  child(bound: LogFields): Logger
}

/**
 * One emitted line, as a SECOND destination sees it: the same message and level the local
 * writer got, with the `child`-bound correlation fields already folded into `fields` (a sink
 * cannot reconstruct them, and they are the half that makes a line joinable to a run).
 */
export interface LogRecord {
  level: LogLevel
  /** The fixed message string. Everything variable lives in {@link fields}. */
  msg: string
  /** Bound fields merged with the call-site ones, bound first so a call site can override. */
  fields: LogFields
  /** Epoch ms the line was emitted at. */
  timeMs: number
}

/**
 * A SECOND destination for emitted lines, beside the local writer: an OTLP collector, a
 * hosted log backend. Registered on the logging adapter by a facade, so the domain keeps
 * logging through the one `Logger` port and knows nothing about where lines go.
 *
 * Two obligations, both inherited from the port itself (`Logger` may not throw, and
 * observability may not break the product):
 *
 * - **`record` must not throw and must not block.** It is called on the emit path of every
 *   line, including the ones reporting a failure the caller is already handling. Buffer and
 *   return; do the I/O in {@link flush}.
 * - **`flush` must never reject.** A sink that cannot deliver drops its batch and says so
 *   through its own logger, exactly like every other best-effort path.
 */
export interface LogSink {
  /** Accept one line. Non-blocking, never throws (see the interface docs). */
  record(record: LogRecord): void
  /** Deliver whatever is buffered. Best-effort: resolves even when the delivery failed. */
  flush(): Promise<void>
}

/**
 * The default wherever a facade wired no logger. Construction stays cheap and a service
 * never has to null-check its logger dep, which is what keeps `logger` non-optional on the
 * services that take one.
 */
export const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => noopLogger,
}

/**
 * Collect every line into an array. For tests that assert a best-effort path logged its
 * drop — the assertion the `runBestEffort` convention exists to make possible.
 */
export interface RecordedLogLine {
  level: LogLevel
  msg: string
  fields: LogFields
}

/** A `Logger` that records instead of emitting. Test-only, but shipped so every package can use it. */
export function createRecordingLogger(
  lines: RecordedLogLine[] = [],
  bound: LogFields = {},
): Logger & { lines: RecordedLogLine[] } {
  const push =
    (level: LogLevel) =>
    (msg: string, fields?: LogFields): void => {
      lines.push({ level, msg, fields: { ...bound, ...fields } })
    }
  return {
    lines,
    debug: push('debug'),
    info: push('info'),
    warn: push('warn'),
    error: push('error'),
    child: (extra) => createRecordingLogger(lines, { ...bound, ...extra }),
  }
}
