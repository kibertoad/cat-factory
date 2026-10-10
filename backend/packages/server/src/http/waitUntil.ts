import type { Context } from 'hono'
import { runBestEffort } from '@cat-factory/kernel'
import { logger } from '../observability/logger.js'
import type { AppEnv } from './env.js'

/**
 * Schedule post-response work. On the Worker the runtime exposes `executionCtx.waitUntil`
 * (keeps the isolate alive past the response so a fire-and-forget write actually completes);
 * on Node there is no such context, so we fall back to plain fire-and-forget (the process is
 * long-lived). Any controller that kicks off best-effort async work AFTER returning its
 * response (telemetry writes, metric records) MUST route it through this — a bare
 * `void promise` is silently dropped on the Worker when the isolate is frozen post-response.
 */
export function makeWaitUntil(c: Context<AppEnv>): (p: Promise<unknown>) => void {
  return (p) => {
    try {
      c.executionCtx.waitUntil(p)
    } catch {
      // No `executionCtx` (Node): plain fire-and-forget. The rejection still has to be
      // handled here or it reaches the process-level `unhandledRejection` guard with no idea
      // which controller scheduled it — a post-response drop names itself instead.
      void runBestEffort(logger, 'waitUntil.postResponse', () => p)
    }
  }
}
