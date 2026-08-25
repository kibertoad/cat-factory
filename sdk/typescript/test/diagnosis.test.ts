// The transport's connection DIAGNOSIS: which cause a chain names, and what the client's own
// history adds to it.
//
// Unreachable from the cross-SDK smoketest, which drives a healthy deployment over a real socket,
// and silent when wrong: the call still throws the class a caller catches, carrying a sentence
// that sends them to the wrong place. A reset and a refusal are the pair that matters, because
// they take opposite investigations (a deployment that is there and restarted, versus an address
// with nothing behind it) and the SDK used to render both as `failed to reach <baseUrl>`.

import { describe, expect, it } from 'vitest'
import { classifyTransportFailure, describeTransportFailure } from '../src/diagnosis.ts'
import { CatFactoryConnectionError } from '../src/errors.ts'
import { type RequestSpec, Transport } from '../src/http.ts'

/** What undici actually throws: a contentless wrapper with the real code one link down. */
const transportFailure = (code: string, message = code): Error =>
  new TypeError('fetch failed', { cause: Object.assign(new Error(message), { code }) })

const describeWith = (
  error: unknown,
  history: { completedCalls: number; lastCompletedAt: number | null } = {
    completedCalls: 0,
    lastCompletedAt: null,
  },
): string =>
  describeTransportFailure({
    method: 'POST',
    path: '/api/v1/tasks',
    baseUrl: 'https://cat.example.test',
    error,
    history,
    now: 1_000_000,
  })

describe('classifyTransportFailure', () => {
  it('reads the DEEPEST link, not the wrapper', () => {
    // A mid-handshake certificate failure arrives wrapped in a socket error that is itself a
    // recognised `reset`. Answering with the wrapper is what sends an operator looking for a
    // proxy instead of pasting a CA bundle.
    const wrapped = new TypeError('fetch failed', {
      cause: Object.assign(new Error('socket error'), {
        code: 'UND_ERR_SOCKET',
        cause: Object.assign(new Error('self-signed certificate'), {
          code: 'DEPTH_ZERO_SELF_SIGNED_CERT',
        }),
      }),
    })
    expect(classifyTransportFailure(wrapped)).toBe('tls-untrusted')
  })

  it('walks an aggregate, which is what a dual-stack host produces', () => {
    const aggregate = new AggregateError(
      [Object.assign(new Error('connect ECONNREFUSED ::1:8787'), { code: 'ECONNREFUSED' })],
      'fetch failed',
    )
    expect(classifyTransportFailure(aggregate)).toBe('refused')
  })

  it('prefers a code over a message match, since a code is a fact and text is a guess', () => {
    const coded = Object.assign(new Error('invalid header value from the proxy'), {
      code: 'ECONNRESET',
    })
    expect(classifyTransportFailure(coded)).toBe('reset')
  })

  it('recognises the one failure that carries no code at all', () => {
    // undici rejects a header value holding a control character before opening a socket, as a bare
    // TypeError: a credential pasted with a line break in it, which is the case most worth naming.
    expect(classifyTransportFailure(new TypeError('invalid header value'))).toBe('invalid-header')
  })

  it('answers `unknown` rather than guessing at a chain it does not recognise', () => {
    expect(classifyTransportFailure(new Error('something else entirely'))).toBe('unknown')
  })
})

describe('describeTransportFailure', () => {
  it('renders a reset and a refusal differently, and neither as a reachability verdict', () => {
    const reset = describeWith(transportFailure('ECONNRESET', 'read ECONNRESET'), {
      completedCalls: 9,
      lastCompletedAt: 999_800,
    })
    expect(reset).toContain('reset the connection before answering')
    expect(reset).toContain('had answered 9 calls')
    expect(reset).toContain('the last 0.2s ago')
    expect(reset).toContain('read ECONNRESET')
    expect(reset).not.toContain('failed to reach')

    const refused = describeWith(transportFailure('ECONNREFUSED', 'connect ECONNREFUSED'))
    expect(refused).toContain('nothing is listening at https://cat.example.test')
    expect(refused).toContain('has not completed a call against https://cat.example.test yet')
  })

  it('drops the contentless wrapper but never the whole diagnosis', () => {
    expect(
      describeWith(transportFailure('ENOTFOUND', 'getaddrinfo ENOTFOUND cat.example.test')),
    ).toContain('(getaddrinfo ENOTFOUND cat.example.test)')
    // Kept when it is ALL there is: an empty parenthetical states less than an unhelpful one.
    expect(describeWith(new TypeError('fetch failed'))).toContain('(fetch failed)')
  })

  it('claims nothing about the origin when the request never left the client', () => {
    const built = describeWith(new TypeError('invalid header value'))
    expect(built).toContain('a header value holds a character that is not allowed in one')
    expect(built).not.toContain('nothing is listening')
  })
})

describe('Transport connection diagnosis', () => {
  it('counts a call the origin ANSWERED, whatever the status it answered with', async () => {
    // A 500 is proof the origin is there, so it is history: the next failure reads as a restart
    // rather than as an address that never answered.
    let calls = 0
    const doFetch = (async () => {
      calls += 1
      if (calls === 1) {
        return new Response('{"error":{"code":"internal","message":"x"}}', { status: 500 })
      }
      throw new TypeError('fetch failed', {
        cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }),
      })
    }) as unknown as typeof globalThis.fetch

    const transport = new Transport({
      baseUrl: 'https://cat.example.test',
      apiKey: 'k',
      maxRetries: 0,
      fetch: doFetch,
    })
    const spec = (method: string): RequestSpec => ({ method, path: '/api/v1/tasks', options: {} })
    await expect(transport.request(spec('POST'))).rejects.toBeInstanceOf(Error)
    const failure = await transport.request(spec('POST')).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(CatFactoryConnectionError)
    expect((failure as Error).message).toContain('had answered 1 call against')
    // The cause chain survives the new message: it is the evidence, and a caller unwrapping it
    // must still find what the runtime reported.
    expect(((failure as Error).cause as Error).message).toBe('fetch failed')
  })
})
