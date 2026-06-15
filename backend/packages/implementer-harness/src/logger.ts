// Minimal zero-dependency structured logger. The container image installs no npm
// packages at runtime (see Dockerfile — it compiles the TS against standalone
// typescript/@types/node and ships only Node built-ins + the global Pi CLI), so
// pino can't live here. This emits pino-shaped JSON lines (level/time/msg +
// fields) which the platform captures from stdout/stderr. The Worker uses pino.

type Level = 'debug' | 'info' | 'warn' | 'error'
type Fields = Record<string, unknown>

function emit(level: Level, msg: string, fields?: Fields): void {
  const line = JSON.stringify({ level, time: new Date().toISOString(), msg, ...fields })
  // Errors/warnings to stderr, everything else to stdout — mirrors pino routing.
  if (level === 'error' || level === 'warn') process.stderr.write(`${line}\n`)
  else process.stdout.write(`${line}\n`)
}

export const log = {
  debug: (msg: string, fields?: Fields): void => emit('debug', msg, fields),
  info: (msg: string, fields?: Fields): void => emit('info', msg, fields),
  warn: (msg: string, fields?: Fields): void => emit('warn', msg, fields),
  error: (msg: string, fields?: Fields): void => emit('error', msg, fields),
}
