import { afterEach, describe, expect, it, vi } from 'vitest'
import { createClient, createPassClient } from './client.js'

const TARGET = { baseUrl: 'https://deployment.invalid', apiKey: 'cfk_test' }

/**
 * A deployment that refuses `failures` connections and then answers.
 *
 * The refusal is the shape a restart actually produces (a transport failure with no response), which
 * is both what the raised budget exists to absorb and what the SDK will replay on a `GET`.
 *
 * Installed on `globalThis` rather than passed as the client's `fetch` option, because that option
 * is how a suite's extra headers ride and a client built WITHOUT any must reach the real global.
 * The SDK binds it at construction, so every client here is built after the stub is in place.
 */
function deploymentRefusing(failures: number): { calls: () => number } {
  let calls = 0
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
    calls += 1
    if (calls <= failures) {
      throw new TypeError('fetch failed', {
        cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:8787'), {
          code: 'ECONNREFUSED',
        }),
      })
    }
    return new Response(JSON.stringify({ models: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  })
  return { calls: () => calls }
}

afterEach(() => {
  vi.restoreAllMocks()
})

// Three refusals then an answer is the one population that tells the two budgets apart at their
// cheapest: the SDK default gives up on it and the pass budget rides through it, with the whole
// backoff ladder under two seconds.
describe('the two retry budgets', () => {
  it('refuses fast before a pass has spent anything', async () => {
    // The budget a preflight probe runs on, and the reason it is the SDK's default rather than a
    // raised one: a dozen checks run in sequence and none bails early, so a deployment that is not
    // running is reported in seconds instead of once every probe has climbed its own ladder.
    const deployment = deploymentRefusing(3)
    await expect(createClient(TARGET).models.list()).rejects.toThrow()
    expect(deployment.calls()).toBe(3)
  })

  it('rides through a restart once a pass has an hour of work at stake', async () => {
    const deployment = deploymentRefusing(3)
    await expect(createPassClient(TARGET).models.list()).resolves.toEqual({ models: [] })
    expect(deployment.calls()).toBe(4)
  })

  it('never replays a write, on either budget', async () => {
    // The property that makes any budget here safe to raise: answering a decision costs real LLM
    // work and a replayed `POST` would answer it twice. It is the SDK's rule rather than ours, so
    // this asserts the rule still holds through the client we build rather than restating it.
    const deployment = deploymentRefusing(1)
    await expect(
      createPassClient(TARGET).tasks.create('svc_1', { title: 'x', taskType: 'feature' }),
    ).rejects.toThrow()
    expect(deployment.calls()).toBe(1)
  })
})

describe('the header seam', () => {
  it('re-reads the headers on EVERY request, which is what a per-user credential needs', async () => {
    // The reason this is a function rather than a record: the credential is not known until a call
    // has already been refused for want of it, and must then ride every later request. Snapshotted
    // at construction (which is what the SDK's own `headers` option does), the client built before
    // the refusal would go on sending none.
    const sent: (string | undefined)[] = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      sent.push(new Headers(init?.headers).get('x-unlock') ?? undefined)
      return new Response(JSON.stringify({ models: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })
    let held: Record<string, string> = {}
    const client = createClient(TARGET, { headers: () => held })
    await client.models.list()
    held = { 'x-unlock': 'held' }
    await client.models.list()
    expect(sent).toEqual([undefined, 'held'])
  })
})
