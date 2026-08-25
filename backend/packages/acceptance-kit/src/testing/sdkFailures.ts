// Transport failures as the SDK ACTUALLY throws them, for the tests that read one.
//
// Three modules here classify or render a thrown probe, and every one of them is reached from a
// real caller through `@cat-factory/sdk`: the kit drives the deployment through the published
// client and never calls `fetch` itself. A fixture built by hand therefore pins a shape nothing
// produces, and the drift is silent in the direction that matters. It already happened: the
// wrapper's message used to be a fixed `failed to reach <baseUrl>` and is now an assembled account
// (ADR 0060), so every hand-written copy of the old sentence kept its tests green through the
// change that broke what an operator reads.
//
// So the fixture is DRIVEN: a real client, a `fetch` that fails the way Node's does, and whatever
// the transport chooses to throw. What a test then asserts is what a pass would actually see.
//
// Excluded from the build (`tsconfig.build.json`), so nothing here is published.

import { CatFactoryConnectionError, CatFactoryClient } from '@cat-factory/sdk'

/** The base URL every fixture here is driven against, and the one the probes name. */
export const FIXTURE_BASE_URL = 'http://127.0.0.1:8787'

/** A transport failure as Node reports one: the contentless wrapper over the informative link. */
export function runtimeFailure(message: string, code: string): Error {
  return new TypeError('fetch failed', { cause: Object.assign(new Error(message), { code }) })
}

/**
 * What the SDK throws when the transport fails, after `answeredCalls` calls it did answer.
 *
 * The history matters to what comes out: the client states whether it had heard from the origin
 * before, which is the half that separates a deployment that restarted from an address that never
 * answered. `maxRetries: 0` because a fixture that replays a failing GET three times is testing the
 * backoff, and the kit's own clients set that budget themselves.
 */
export async function sdkTransportFailure(options: {
  message: string
  code: string
  answeredCalls?: number
  baseUrl?: string
}): Promise<CatFactoryConnectionError> {
  const baseUrl = options.baseUrl ?? FIXTURE_BASE_URL
  const answers = options.answeredCalls ?? 0
  let calls = 0
  const client = new CatFactoryClient({
    baseUrl,
    apiKey: 'cf_pat_fixture',
    maxRetries: 0,
    fetch: (async () => {
      calls += 1
      if (calls <= answers) {
        return new Response('{"userId":"usr_1"}', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      throw runtimeFailure(options.message, options.code)
    }) as typeof globalThis.fetch,
  })
  for (let call = 0; call < answers; call += 1) await client.me.get()
  try {
    await client.me.get()
  } catch (error) {
    if (error instanceof CatFactoryConnectionError) return error
    throw error
  }
  throw new Error('the fixture client answered where it was set up to fail')
}

/** The commonest one: a deployment that is not listening, seen by a client that had been served. */
export function sdkRefusedAfter(answeredCalls: number): Promise<CatFactoryConnectionError> {
  return sdkTransportFailure({
    message: 'connect ECONNREFUSED 127.0.0.1:8787',
    code: 'ECONNREFUSED',
    answeredCalls,
  })
}
