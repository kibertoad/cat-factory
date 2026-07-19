import { SchemaValidationError } from '@toad-contracts/core'
import { apiErrorStatus } from '~/composables/api/errors'

/**
 * True only for a not-listening-yet backend — a connection-level fault (connection refused /
 * reset / DNS) that throws before any HTTP round-trip completes, so it carries neither an HTTP
 * status nor schema issues. Everything else is a real, deterministic answer that retrying can
 * never clear, so it must surface at once, not loop:
 *
 * - An HTTP RESPONSE arrived — a declared non-2xx (`ApiError`) or an undeclared status
 *   (`UnexpectedResponseError`); both carry a `statusCode`, so `apiErrorStatus` returns it.
 * - A `SchemaValidationError` — the backend answered but its body (or our own request) didn't
 *   match the contract, i.e. a version skew / client bug, NOT a dead socket.
 */
export function isBackendUnreachable(error: unknown): boolean {
  if (error instanceof SchemaValidationError) return false
  return apiErrorStatus(error) === undefined
}

export interface BackendRetryOptions {
  /** Total wall-clock budget before we give up and rethrow (default 15s). */
  deadlineMs?: number
  /** First backoff delay; doubles each attempt up to {@link BackendRetryOptions.maxDelayMs}. */
  baseDelayMs?: number
  /** Backoff ceiling (default 2s). */
  maxDelayMs?: number
}

/**
 * Run `fn`, retrying while the backend is merely not-listening-yet (see
 * {@link isBackendUnreachable}) with exponential backoff, up to a wall-clock deadline.
 *
 * This exists for the cold-open race: when the frontend and backend are started together,
 * the SPA's first fetch can beat the backend's listener by a second or two. A single attempt
 * would strand the board on the "Can't reach the backend" screen until a manual reload, even
 * though the backend comes up moments later. An HTTP error response (any status) is a real
 * answer, so it rethrows immediately rather than looping — we only wait out a dead socket.
 */
export async function retryWhileBackendUnreachable<T>(
  fn: () => Promise<T>,
  { deadlineMs = 15_000, baseDelayMs = 300, maxDelayMs = 2_000 }: BackendRetryOptions = {},
): Promise<T> {
  const start = Date.now()
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn()
    } catch (error) {
      const elapsed = Date.now() - start
      if (!isBackendUnreachable(error) || elapsed >= deadlineMs) throw error
      const delay = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt, deadlineMs - elapsed)
      await new Promise<void>((resolve) => setTimeout(resolve, delay))
    }
  }
}
