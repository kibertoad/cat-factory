// The convention for a deliberately-swallowed failure. A background write, a tracker
// echo, a lease release, a notification raise: work whose failure must NOT propagate into
// the caller, but which was previously dropped by `.catch(() => {})` — leaving no log, no
// metric and no marker (see `docs/initiatives/observability-logging-gaps.md`, B1).
//
// `runBestEffort` keeps the swallow and adds the evidence. Every drop becomes one
// `warn` line naming the operation, with the cause scrubbed. Patterns and the rules for
// when to use it: `backend/docs/logging.md`.

import type { LogFields, Logger } from '../ports/logging.js'
import { redactSecrets } from './redact-secrets.logic.js'

/**
 * Describe a thrown value as log fields. The message is scrubbed with `redactSecrets`
 * because an error surfaced from `fetch`, a shell spawn or a provider SDK routinely
 * echoes the URL (with its query) or an auth header back in its text.
 *
 * Only the message and the constructor name are kept: a stack is high-volume and rarely
 * the thing that identifies the failure in a structured log. Pass one explicitly when a
 * specific site needs it.
 */
export function describeError(error: unknown): LogFields {
  if (error instanceof Error) {
    return { err: redactSecrets(error.message) ?? '', errKind: error.name }
  }
  return { err: redactSecrets(String(error)) ?? '', errKind: typeof error }
}

/**
 * Run `fn` and swallow any rejection, logging it at `warn` with `label` as the operation
 * name. Returns `undefined` when the work failed, so a caller that wants the value can
 * still branch on it, and never rejects.
 *
 * Use it for work that is genuinely optional. It is the WRONG tool when the failure should
 * change what the caller does — that wants a real `try`/`catch` with a domain decision.
 *
 * ```ts
 * void runBestEffort(logger, 'execution.autoStartDependents', () => this.autoStartDependents(id), {
 *   workspaceId,
 *   executionId,
 * })
 * ```
 */
export async function runBestEffort<T>(
  logger: Logger,
  label: string,
  fn: () => Promise<T> | T,
  fields: LogFields = {},
): Promise<T | undefined> {
  try {
    return await fn()
  } catch (error) {
    logger.warn(`best-effort ${label} failed`, { ...fields, ...describeError(error) })
    return undefined
  }
}
