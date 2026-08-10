// The convention for a deliberately-swallowed failure. A background write, a tracker
// echo, a lease release, a notification raise: work whose failure must NOT propagate into
// the caller, but which was previously dropped by `.catch(() => {})` — leaving no log, no
// metric and no marker (see `docs/initiatives/observability-logging-gaps.md`, B1).
//
// `runBestEffort` keeps the swallow and adds the evidence. Every drop becomes one
// `warn` line naming the operation, with the cause scrubbed. Patterns and the rules for
// when to use it: `backend/docs/logging.md`.

import type { LogFields, Logger } from '../ports/logging.js'
import { errorChainText, MAX_LOGGED_ERROR_CHAIN_CHARS } from './error-chain.logic.js'

/**
 * Describe a thrown value as log fields. The message is scrubbed with `redactSecrets`
 * because an error surfaced from `fetch`, a shell spawn or a provider SDK routinely
 * echoes the URL (with its query) or an auth header back in its text.
 *
 * `err` is the whole CAUSE CHAIN, not just `error.message` (see `error-chain.logic.ts`). A
 * transport failure's message is undici's contentless `fetch failed` and what happened lives one
 * `.cause` down, so a line built from the message alone reported every unreachable host, untrusted
 * certificate and DNS typo as the same three words: the operator's log said nothing the moment it
 * mattered most.
 *
 * Only the chain and the constructor name are kept: a stack is high-volume and rarely
 * the thing that identifies the failure in a structured log. Pass one explicitly when a
 * specific site needs it.
 *
 * The chain is capped at the LOG budget, not the human one. A toast has a few lines of room; this
 * field is where an operator goes when those lines were not enough, and the detail that makes the
 * trip worth it (a quoted SQL statement, a provider's JSON error body) is long by nature.
 */
export function describeError(error: unknown): LogFields {
  return {
    err: errorChainText(error, MAX_LOGGED_ERROR_CHAIN_CHARS),
    errKind: error instanceof Error ? error.name : typeof error,
  }
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
