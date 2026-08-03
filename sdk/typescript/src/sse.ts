// The server-sent-events reader for the two streaming endpoints (`GET /tasks/:id/events` and
// `GET /jobs/:id/events`).
//
// Written by hand rather than leaned on a dependency for one reason: the framing rules that
// matter here are the ones a naive `split('\n\n')` gets wrong, and getting them wrong shows up
// as a run that silently appears to stall.
//
//   - A chunk boundary can fall ANYWHERE, including inside a `data:` line. So bytes accumulate
//     in a buffer and only a COMPLETE record (terminated by a blank line) is dispatched.
//   - A record may carry several `data:` lines; per the spec they join with `\n`. Taking only
//     the last would silently truncate a multi-line run projection.
//   - The stream ends in one of three ways the caller must tell apart: a terminal `done`/`error`
//     event, a `timeout` event when the deployment's connection cap is reached, or the socket
//     simply closing. Only the first is the run reaching a verdict; treating a cap or a dropped
//     socket as "finished" is how a poller concludes a running job succeeded.

/** One decoded SSE record. */
export interface StreamEvent {
  /** The `event:` field, or `message` when the server sent none (the SSE default). */
  event: string
  /** The joined `data:` payload, verbatim. */
  data: string
  /** The `id:` field, when present. */
  id?: string
  /** `data` parsed as JSON, or null when it is not JSON (e.g. a bare keep-alive). */
  json<T = unknown>(): T | null
}

/**
 * An async-iterable stream of events, plus the reason it ended.
 *
 * Iterate it with `for await`. Always `close()` when leaving early (or use the iteration to
 * completion), so the underlying socket is released rather than held to the server's cap.
 */
export interface EventStream extends AsyncIterable<StreamEvent> {
  /** Abort the stream and release the socket. Safe to call more than once. */
  close(): Promise<void>
}

const decodeEvent = (raw: string): StreamEvent | null => {
  let event = 'message'
  let id: string | undefined
  const data: string[] = []
  for (const line of raw.split('\n')) {
    // A leading colon is a comment — servers send them as keep-alives. Never a record.
    if (line.startsWith(':')) continue
    const colon = line.indexOf(':')
    const field = colon === -1 ? line : line.slice(0, colon)
    // One optional leading space after the colon is part of the framing, not the value.
    const rawValue = colon === -1 ? '' : line.slice(colon + 1)
    const value = rawValue.startsWith(' ') ? rawValue.slice(1) : rawValue
    if (field === 'event') event = value
    else if (field === 'data') data.push(value)
    else if (field === 'id') id = value
  }
  if (data.length === 0 && event === 'message') return null
  const payload = data.join('\n')
  return {
    event,
    data: payload,
    id,
    json<T>(): T | null {
      try {
        return JSON.parse(payload) as T
      } catch {
        return null
      }
    },
  }
}

/** Wrap a response body stream as an `EventStream`. */
export function readEventStream(body: ReadableStream<Uint8Array>): EventStream {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let closed = false

  /**
   * Release the socket. Idempotent, and the ONLY place that does so.
   *
   * `close()` deliberately does not rely on `iterator.return()` for this: an async generator that
   * has never been advanced has not entered its `try`, so `return()` resolves without running the
   * `finally` below — the reader stays locked and the body is never cancelled. That is precisely
   * the path a caller takes when they open a stream and abandon it before reading (an early
   * `return`, a failed guard, a `finally` on a path that threw first), which is the case `close()`
   * exists for. So both the iterator's `finally` and `close()` funnel here instead.
   */
  const release = async (): Promise<void> => {
    if (closed) return
    closed = true
    reader.releaseLock()
    // silent-catch-ok: cancelling an already-cancelled body is the state we were trying to
    // reach, and this SDK has no logger to report through — it depends on nothing, because a
    // client library's dependencies become every consumer's.
    await body.cancel().catch(() => {})
  }

  async function* iterate(): AsyncGenerator<StreamEvent> {
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        // `\r\n\r\n` as well as `\n\n`: the spec allows either line terminator, and a server
        // behind a proxy that normalizes line endings would otherwise never appear to emit a
        // complete record at all.
        let boundary = buffer.search(/\r?\n\r?\n/)
        while (boundary !== -1) {
          const raw = buffer.slice(0, boundary).replace(/\r/g, '')
          buffer = buffer.slice(boundary + (buffer.startsWith('\r\n\r\n', boundary) ? 4 : 2))
          const decoded = decodeEvent(raw)
          if (decoded) yield decoded
          boundary = buffer.search(/\r?\n\r?\n/)
        }
      }
      // A record left unterminated when the socket closed is still a record the server sent.
      // Dropping it would lose exactly the terminal `done` frame in the case where the server
      // closes the connection in the same breath as emitting it.
      const trailing = decodeEvent(buffer.replace(/\r/g, '').trim())
      if (trailing) yield trailing
    } finally {
      await release()
    }
  }

  const iterator = iterate()
  return {
    [Symbol.asyncIterator]: () => iterator,
    async close() {
      // Ask the generator to unwind first so an in-flight `read()` is not left dangling; then
      // release unconditionally, which is what covers the never-started case.
      // silent-catch-ok: the generator rejects here only if it had already faulted, which the
      // caller saw at the point it faulted; re-raising from close() would replace their real
      // failure with a second report of it.
      await iterator.return(undefined as never).catch(() => {})
      await release()
    },
  }
}
