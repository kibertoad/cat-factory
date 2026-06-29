// Minimal zero-dependency structured logger. The container image installs no npm
// packages at runtime (see Dockerfile — it compiles the TS against standalone
// typescript/@types/node and ships only Node built-ins + the global Pi CLI), so
// pino can't live here. This emits pino-shaped JSON lines (level/time/msg +
// fields) which the platform captures from stdout/stderr. The Worker uses pino.

type Level = 'debug' | 'info' | 'warn' | 'error'
type Fields = Record<string, unknown>

function emit(level: Level, msg: string, bound: Fields, fields?: Fields): void {
  // Bound (per-job context) fields first so a call site can still override a key.
  const line = JSON.stringify({ level, time: new Date().toISOString(), msg, ...bound, ...fields })
  // Errors/warnings to stderr, everything else to stdout — mirrors pino routing.
  if (level === 'error' || level === 'warn') process.stderr.write(`${line}\n`)
  else process.stdout.write(`${line}\n`)
}

/** The logging surface: the four levels plus `child` to bind correlation fields once. */
export interface Logger {
  debug: (msg: string, fields?: Fields) => void
  info: (msg: string, fields?: Fields) => void
  warn: (msg: string, fields?: Fields) => void
  error: (msg: string, fields?: Fields) => void
  /**
   * Return a logger that merges `bound` into every line (e.g. `{ jobId, repo, branch }`),
   * so a per-job logger carries its correlation context without each call site re-spreading
   * it. Nestable — the returned logger's own `child` accumulates onto these bound fields.
   */
  child: (bound: Fields) => Logger
}

/** Build a logger whose every emit folds in `bound`. The root logger binds nothing. */
function makeLogger(bound: Fields): Logger {
  return {
    debug: (msg, fields) => emit('debug', msg, bound, fields),
    info: (msg, fields) => emit('info', msg, bound, fields),
    warn: (msg, fields) => emit('warn', msg, bound, fields),
    error: (msg, fields) => emit('error', msg, bound, fields),
    child: (extra) => makeLogger({ ...bound, ...extra }),
  }
}

export const log: Logger = makeLogger({})
