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
      closed = true
      reader.releaseLock()
      await body.cancel().catch(() => {
        // The body is already gone — that is the state we were trying to reach.
      })
    }
  }

  const iterator = iterate()
  return {
    [Symbol.asyncIterator]: () => iterator,
    async close() {
      if (closed) return
      closed = true
      await iterator.return(undefined as never).catch(() => {
        // Closing a stream that already faulted is not itself a failure.
      })
    },
  }
}
