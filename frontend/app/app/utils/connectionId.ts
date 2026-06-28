/**
 * A stable per-tab connection id, generated once on first use. It rides on every REST
 * request (the `X-Connection-Id` header, added in the api client) AND on the realtime
 * WebSocket connect (`?cid=`), so the backend can recognise the connection that caused a
 * board mutation and skip echoing the resulting coarse `board` event back to it.
 *
 * Without this, a client consumes the WebSocket event for its OWN move and runs a
 * debounced full board refresh; a snapshot fetched mid-flight (between two rapid drags)
 * carries a stale position, so the block snaps back to where it was after the previous
 * move. Suppressing the self-echo leaves the originating client on its optimistic state +
 * its own REST response (already the freshest), while other clients still refresh.
 */
let cached: string | null = null

export function connectionId(): string {
  if (cached) return cached
  cached =
    globalThis.crypto?.randomUUID?.() ??
    `cid-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  return cached
}
