import pino from 'pino'

// Structured logging for the Worker. The default pino transport relies on Node
// worker threads, which workerd doesn't provide, so we use pino's browser API
// with an explicit per-level `write` that emits one JSON line to the matching
// `console` method. Cloudflare captures `console.*` (visible via `wrangler tail`
// / Logpush), so this gives queryable, level-routed structured logs at the edge.

const LEVEL = (globalThis as { LOG_LEVEL?: string }).LOG_LEVEL ?? 'info'

function write(level: string): (o: object) => void {
  return (o: object) => {
    const line = JSON.stringify({ level, ...o })
    if (level === 'error' || level === 'fatal') console.error(line)
    else if (level === 'warn') console.warn(line)
    else console.log(line)
  }
}

/**
 * Process-wide logger. Prefer `logger.child({ … })` (or pass a `fields` object)
 * to attach correlation context — workspaceId, executionId, jobId — so a run can
 * be traced across the request, the workflow and the container.
 */
export const logger = pino({
  level: LEVEL,
  browser: {
    asObject: true,
    write: {
      trace: write('trace'),
      debug: write('debug'),
      info: write('info'),
      warn: write('warn'),
      error: write('error'),
      fatal: write('fatal'),
    },
  },
})

export type Logger = typeof logger
