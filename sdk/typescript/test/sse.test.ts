// The SSE reader's framing rules.
//
// The smoketest proves the stream works end to end, but it cannot provoke the cases that actually
// bite — a chunk boundary landing mid-record, a multi-line payload, a terminal frame arriving in
// the same breath as the socket closing. Each of those shows up in production as a run that
// silently appears to stall, so each gets a test that constructs the byte sequence directly.

import { describe, expect, it } from 'vitest'
import { readEventStream, type StreamEvent } from '../src/sse.ts'

/** A body stream that emits exactly the given chunks, so a boundary can be placed anywhere. */
function bodyOf(...chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  })
}

async function collect(...chunks: string[]): Promise<StreamEvent[]> {
  const events: StreamEvent[] = []
  for await (const event of readEventStream(bodyOf(...chunks))) events.push(event)
  return events
}

describe('readEventStream', () => {
  it('decodes a record split across chunk boundaries', async () => {
    // The boundary falls INSIDE the `data:` line. A reader that decoded per chunk would emit two
    // broken records here, or none.
    const events = await collect('event: progress\ndata: {"run', 'Id":"r1"}\n\n')
    expect(events).toHaveLength(1)
    expect(events[0]?.event).toBe('progress')
    expect(events[0]?.json()).toEqual({ runId: 'r1' })
  })

  it('joins multiple data lines with a newline', async () => {
    // Per the SSE spec. Taking only the last line would silently truncate a payload.
    const events = await collect('event: progress\ndata: line one\ndata: line two\n\n')
    expect(events[0]?.data).toBe('line one\nline two')
  })

  it('yields a trailing record the server sent without a terminating blank line', async () => {
    // The case that matters: a server closing the connection in the same breath as its terminal
    // frame. Dropping the unterminated record loses exactly the `done` the caller is waiting for.
    const events = await collect(
      'event: progress\ndata: {}\n\n',
      'event: done\ndata: {"ok":true}\n',
    )
    expect(events.map((e) => e.event)).toEqual(['progress', 'done'])
    expect(events[1]?.json()).toEqual({ ok: true })
  })

  it('ignores comment keep-alives', async () => {
    // Servers send `:` lines to hold the connection open. Treating one as a record would hand the
    // caller a phantom event on a perfectly healthy stream.
    const events = await collect(': keep-alive\n\n', 'event: done\ndata: {}\n\n')
    expect(events.map((e) => e.event)).toEqual(['done'])
  })

  it('accepts CRLF line endings', async () => {
    // A proxy that normalizes line endings would otherwise make the stream appear to emit nothing
    // at all, because no complete record would ever be recognised.
    const events = await collect('event: progress\r\ndata: {"a":1}\r\n\r\n')
    expect(events).toHaveLength(1)
    expect(events[0]?.json()).toEqual({ a: 1 })
  })

  it('strips exactly one leading space after the colon', async () => {
    // The single space is framing; a second one is payload.
    const events = await collect('event: progress\ndata:  padded\n\n')
    expect(events[0]?.data).toBe(' padded')
  })

  it('defaults the event name to `message` when the server sends none', async () => {
    const events = await collect('data: {"a":1}\n\n')
    expect(events[0]?.event).toBe('message')
  })

  it('returns null from json() for a payload that is not JSON', async () => {
    // Returning null rather than throwing: a non-JSON frame mid-stream is normal, and a client
    // that raised on one would fail on a healthy connection.
    const events = await collect('event: progress\ndata: not json\n\n')
    expect(events[0]?.json()).toBeNull()
  })

  it('releases the body when closed early', async () => {
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('event: progress\ndata: {}\n\n'))
        // Deliberately never closed: this models a live run's open stream.
      },
      cancel() {
        cancelled = true
      },
    })
    const stream = readEventStream(body)
    for await (const _event of stream) break
    await stream.close()
    expect(cancelled).toBe(true)
  })
})
