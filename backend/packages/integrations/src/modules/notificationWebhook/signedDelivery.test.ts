import { describe, expect, it } from 'vitest'
import {
  fanOutSignedWebhook,
  type SignedDeliveryTarget,
  WebhookDeliveryNotAttemptedError,
} from './signedDelivery.js'

// The FAN-OUT's own properties, which the three sinks above it cannot pin: they each drive one or
// two endpoints, so the concurrency bound, the shared wall-clock budget and the not-attempted
// report only become observable with more endpoints than the bound. The retry / signature / SSRF
// behaviour of a single delivery stays pinned in the sink tests, which is where a payload exists to
// assert against.

const cipher = {
  encrypt: async (plaintext: string) => `sealed:${plaintext}`,
  decrypt: async (envelope: string) => envelope.replace(/^sealed:/, ''),
}

/**
 * A clock that only moves when a test moves it, so a budget is spent deliberately rather than by
 * whatever the machine was doing. Real time would make every assertion here a race.
 */
function manualClock(start = 1_700_000_000_000) {
  let current = start
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms
    },
  }
}

function targets(count: number): SignedDeliveryTarget[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `hook-${index}`,
    url: `https://hook-${index}.test/deliver`,
    secretSealed: null,
  }))
}

const delivery = { payload: '{"hello":"world"}', sentAt: 1_700_000_000_000 }

describe('fanOutSignedWebhook', () => {
  it('never has more than six deliveries in flight at once', async () => {
    // Six is the Cloudflare Workers ceiling on simultaneous open connections, and a seventh
    // `fetch` queues rather than failing. An unbounded fan-out therefore buys no parallelism past
    // six while still starting the seventh endpoint's clock, which is what made a queued endpoint
    // report a failure it never attempted.
    const clock = manualClock()
    let inFlight = 0
    let peak = 0
    const release: Array<() => void> = []

    const fanOut = fanOutSignedWebhook(
      { secretCipher: cipher, clock, fetchImpl: fetchHoldingOpen() },
      targets(10),
      delivery,
      () => {
        throw new Error('no endpoint should have failed')
      },
    )

    // Let the pool fill, then drain it one delivery at a time, watching the high-water mark.
    await tick()
    while (release.length > 0) {
      release.shift()?.()
      await tick()
    }
    await fanOut
    expect(peak).toBe(6)

    function fetchHoldingOpen(): typeof fetch {
      return (async () => {
        inFlight += 1
        peak = Math.max(peak, inFlight)
        await new Promise<void>((resolve) => release.push(resolve))
        inFlight -= 1
        return new Response(null, { status: 204 })
      }) as unknown as typeof fetch
    }
  })

  it('spends ONE budget across every endpoint, and says so for the ones it never reached', async () => {
    // The budget bounds what the CALLER waits for on a run's terminal path, and the caller waits
    // for the whole fan-out, so a per-endpoint budget would bound nothing once a workspace
    // registers several. Here the first wave burns all 6000ms, which must leave the rest reported
    // as not attempted rather than posted to late or silently dropped.
    const clock = manualClock()
    const posted: string[] = []
    const failures: Array<{ id: string; error: unknown }> = []

    await fanOutSignedWebhook(
      {
        secretCipher: cipher,
        clock,
        sleep: async () => {},
        fetchImpl: (async (url: string) => {
          posted.push(url)
          // Yield before spending the budget, so the whole first wave is in flight when the clock
          // moves. Without it the fake resolves inside the caller's synchronous prefix and the
          // pool never fills, which would test the fake rather than the fan-out.
          await tick()
          // Each delivery in the first wave eats the whole budget, exactly as six dead receivers
          // sharing one deadline would.
          clock.advance(6000)
          return new Response(null, { status: 204 })
        }) as unknown as typeof fetch,
      },
      targets(10),
      delivery,
      (error, target) => failures.push({ id: target.id, error }),
    )

    expect(posted).toHaveLength(6)
    // The remaining four are REPORTED, and reported as a different thing from a delivery failure:
    // "we never asked" and "the receiver rejected us" send an operator to different places.
    expect(failures.map((failure) => failure.id)).toEqual(['hook-6', 'hook-7', 'hook-8', 'hook-9'])
    for (const failure of failures) {
      expect(failure.error).toBeInstanceOf(WebhookDeliveryNotAttemptedError)
    }
  })

  it('isolates a failing endpoint, delivering to and reporting on each one separately', async () => {
    const clock = manualClock()
    const posted: string[] = []
    const failed: string[] = []

    await fanOutSignedWebhook(
      {
        secretCipher: cipher,
        clock,
        sleep: async () => {},
        fetchImpl: (async (url: string) => {
          posted.push(url)
          // A 4xx is terminal, so this endpoint spends one attempt rather than three and cannot
          // starve its siblings of the shared budget.
          return new Response(null, { status: url.includes('hook-1') ? 410 : 204 })
        }) as unknown as typeof fetch,
      },
      targets(3),
      delivery,
      (_error, target) => failed.push(target.id),
    )

    // One broken receiver costs only its own delivery: a rejected `Promise.all` would have
    // reported a single failure for the batch and hidden the health of the other two.
    expect(failed).toEqual(['hook-1'])
    expect(posted).toHaveLength(3)
  })

  it('does nothing, and never throws, with no subscribed endpoints', async () => {
    const clock = manualClock()
    await expect(
      fanOutSignedWebhook(
        {
          secretCipher: cipher,
          clock,
          fetchImpl: (() => {
            throw new Error('must not fetch')
          }) as unknown as typeof fetch,
        },
        [],
        delivery,
        () => {
          throw new Error('must not report')
        },
      ),
    ).resolves.toBeUndefined()
  })
})

/** Yield long enough for every already-resolved microtask continuation to run. */
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}
