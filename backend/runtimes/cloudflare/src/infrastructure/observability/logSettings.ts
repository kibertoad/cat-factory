import { parseLogLevel, setLogLevel } from '@cat-factory/server'
import type { Env } from '../env'
import { loadOtelConfig } from '../config/otel'
import { flushOtelLogsForIsolate, installOtelLogSink } from './logExport'

// Both of this facade's logging settings live in MODULE state inside `@cat-factory/server`, and
// module state on a Worker is per ISOLATE. There is no boot that runs once for the deployment:
// whichever entry point workerd happens to start a fresh isolate on is the one that has to
// establish them, so every entry point applies them FIRST and drains what its isolate holds
// before that isolate is discarded.
//
// This pair used to live as private helpers inside `index.ts`, which is why the WORKFLOW entry
// points had neither. A `WorkflowEntrypoint` is not reached through `fetch`/`scheduled`/`queue`
// (workerd instantiates the class in its own isolate), so a workflow's isolate ran at the
// default `info` threshold with no sink installed, and every line the durable drivers emit (the
// whole engine, every advance, every poll, every failure) reached the local writer only. One
// definition, applied by all eight entry points, is what keeps that from silently recurring the
// next time one is added.

/**
 * Apply this isolate's logging settings from `env`: the emit threshold, and the opt-in OTLP log
 * sink emitted lines are copied to.
 *
 * Idempotent and cheap (an env parse plus a null check), so it is not once-guarded.
 *
 * Reads `loadOtelConfig` rather than the whole `loadConfig`: this runs before the handler, and a
 * deployment whose config validation fails must still serve its misconfiguration fallback with
 * logging intact.
 */
export function applyLogSettings(env: Env): void {
  setLogLevel(parseLogLevel(env.LOG_LEVEL))
  installOtelLogSink(loadOtelConfig(env))
}

/**
 * Flush whatever THIS isolate has buffered, as a promise that always resolves.
 *
 * The `null`-collapsing twin of {@link flushOtelLogsForIsolate}, for the callers that AWAIT the
 * drain rather than handing it to `ctx.waitUntil`: a workflow has no post-response moment to
 * schedule against, so it awaits, and `?? Promise.resolve()` at each of those call sites is
 * noise that hides the one thing worth reading there.
 */
export function flushIsolateLogs(env: Env): Promise<void> {
  return flushOtelLogsForIsolate(loadOtelConfig(env)) ?? Promise.resolve()
}
