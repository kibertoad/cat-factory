// The transport's failure classification and retry policy.
//
// These are the decisions the generated operation methods delegate entirely — what may be
// replayed, what a cancellation means, which error class a caller catches — and none of them is
// reachable from the cross-SDK smoketest, which drives a healthy deployment over a real socket.
// A misclassification here is silent: the call still returns or throws, just as the wrong thing.

import { describe, expect, it, vi } from 'vitest'
import { CatFactoryConnectionError, CatFactoryTimeoutError } from '../src/errors.ts'
import { type RequestSpec, Transport } from '../src/http.ts'

const spec = (method: string, options: RequestSpec['options'] = {}): RequestSpec => ({
  method,
  path: '/api/v1/things',
  options,
})

const transportWith = (doFetch: typeof globalThis.fetch, maxRetries = 2): Transport =>
  new Transport({ baseUrl: 'https://example.test', apiKey: 'k', maxRetries, fetch: doFetch })

describe('Transport cancellation', () => {
  it('does not retry or re-wrap a caller abort carrying a non-AbortError reason', async () => {
    // `abort(reason)` rejects the fetch with that reason VERBATIM, so a caller aborting with a
    // plain Error produces a rejection whose `name` is not `AbortError`. Classifying on the name
    // alone sent this down the retry path: a cancelled GET was replayed to the budget — against a
    // deployment the caller had already walked away from — and then reported as a connection
    // failure, which is neither what happened nor what was asked for.
    const controller = new AbortController()
    const reason = new Error('user navigated away')
    const doFetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      controller.abort(reason)
      throw (init?.signal as AbortSignal | undefined)?.reason ?? reason
    }) as unknown as typeof globalThis.fetch

    await expect(
      transportWith(doFetch).request(spec('GET', { signal: controller.signal })),
    ).rejects.toBe(reason)
    expect(doFetch).toHaveBeenCalledTimes(1)
  })

  it('reports OUR deadline as a timeout, distinct from a cancellation', async () => {
    // The other half of the same branch: a timeout is a verdict the caller may want to retry with
    // a longer budget, so it must not arrive as the connection error a dropped socket produces.
    const doFetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      await new Promise<void>((resolve) => {
        ;(init?.signal as AbortSignal | undefined)?.addEventListener('abort', () => resolve(), {
          once: true,
        })
      })
      throw (init?.signal as AbortSignal | undefined)?.reason
    }) as unknown as typeof globalThis.fetch

    const transport = new Transport({
      baseUrl: 'https://example.test',
      apiKey: 'k',
      maxRetries: 0,
      timeoutMs: 10,
      fetch: doFetch,
    })
    await expect(transport.request(spec('GET'))).rejects.toBeInstanceOf(CatFactoryTimeoutError)
  })
})

describe('Transport retry policy', () => {
  it('replays an idempotent request after a transport failure', async () => {
    let calls = 0
    const doFetch = (async () => {
      calls += 1
      if (calls === 1) throw new TypeError('fetch failed')
      return new Response('{"ok":true}', { status: 200 })
    }) as unknown as typeof globalThis.fetch

    await expect(transportWith(doFetch).request(spec('GET'))).resolves.toEqual({ ok: true })
    expect(calls).toBe(2)
  })

  it('never replays a non-idempotent request', async () => {
    // `POST /jobs` and `POST /tasks/:id/start` cost real LLM work, and a transport failure
    // with no response says nothing about whether the server acted — so a duplicate is not a risk
    // the SDK may take on the caller's behalf.
    let calls = 0
    const doFetch = (async () => {
      calls += 1
      throw new TypeError('fetch failed')
    }) as unknown as typeof globalThis.fetch

    await expect(transportWith(doFetch).request(spec('POST'))).rejects.toBeInstanceOf(
      CatFactoryConnectionError,
    )
    expect(calls).toBe(1)
  })
})
