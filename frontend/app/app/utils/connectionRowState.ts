/**
 * What a hub row says about a user-scoped connection: whether it has rows to show, and its
 * store's load state (`createUserScopedLoad`).
 *
 * `connected` wins over everything: rows in the store are real, whether they came from this
 * load, an earlier one, or a save made after a failed load. With nothing to show, an in-flight
 * load reads as `checking` rather than "Not connected" (which covers the first open and a reopen
 * after a failure), then `failed` when the last load did not happen, else `idle`.
 */
export type ConnectionRowState = 'connected' | 'checking' | 'failed' | 'idle'

export function connectionRowState(
  connected: boolean,
  load: { loading: boolean; loadFailed: boolean },
): ConnectionRowState {
  if (connected) return 'connected'
  if (load.loading) return 'checking'
  if (load.loadFailed) return 'failed'
  return 'idle'
}
