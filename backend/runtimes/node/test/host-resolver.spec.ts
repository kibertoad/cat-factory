import { beforeEach, describe, expect, it, vi } from 'vitest'

// The Node facade's `HostResolver`. Thin over `dns.lookup`, and the two rules it does own are both
// rules about how a failure is CLASSIFIED, which is what decides whether a proof settles a frame.
//
// `node:dns/promises` is mocked rather than reached: a unit test making a real lookup asserts what
// the machine's network says today, which is the failure mode the whole route-proof feature exists
// to stop the platform reasoning from.

const lookup = vi.hoisted(() => vi.fn())
vi.mock('node:dns/promises', () => ({ lookup }))

const { nodeHostResolver } = await import('../src/hostResolver.js')

const errno = (code: string) => Object.assign(new Error(code), { code })

/**
 * Make every lookup hang until the returned release is called, and hand back that release.
 *
 * Every test that hangs one RELEASES it before it ends. `dns.lookup` cannot be cancelled, so the
 * adapter's concurrency gate holds its slot until the lookup itself settles: a spec that walked
 * away from a hung one would leave that slot held for the rest of the file.
 */
const hangingLookups = () => {
  const pending: (() => void)[] = []
  lookup.mockImplementation(
    () => new Promise<{ address: string }[]>((resolve) => pending.push(() => resolve([]))),
  )
  return async () => {
    for (const answer of pending) answer()
    // Let the release ripple through the gate's queue: a waiter handed a slot only to find its own
    // deadline already fired passes it straight on, which is several microtask turns away.
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

// Braced, not an arrow expression: a hook that RETURNS a value hands vitest a teardown, and
// the value here is the mock itself, which it would then call after every test.
beforeEach(() => {
  lookup.mockReset()
})

describe('nodeHostResolver', () => {
  it('asks for EVERY address and keeps the resolver order', async () => {
    // A balancer publishes one address per availability zone, and the first is no likelier to
    // carry than the rest. `verbatim` keeps the resolver's own order rather than re-sorting IPv4
    // ahead of IPv6, which nothing here has a reason to re-impose.
    lookup.mockResolvedValue([
      { address: '2a05:d014::1', family: 6 },
      { address: '35.158.50.136', family: 4 },
    ])
    await expect(nodeHostResolver({ host: 'alb.example', timeoutMs: 500 })).resolves.toEqual({
      state: 'resolved',
      addresses: ['2a05:d014::1', '35.158.50.136'],
    })
    expect(lookup).toHaveBeenCalledWith('alb.example', { all: true, verbatim: true })
  })

  it('reads a name with nothing behind it as a fact about the NAME', async () => {
    // The one outcome that establishes anything: that candidate is a dead end, so a proof may
    // settle on it. An EMPTY answer is the same fact as `ENODATA`, not a third one.
    lookup.mockRejectedValue(errno('ENOTFOUND'))
    await expect(nodeHostResolver({ host: 'gone.example', timeoutMs: 500 })).resolves.toEqual({
      state: 'unresolved',
    })
    lookup.mockResolvedValue([])
    await expect(nodeHostResolver({ host: 'empty.example', timeoutMs: 500 })).resolves.toEqual({
      state: 'unresolved',
    })
  })

  it('never reads a TRANSIENT resolver failure as a name that does not exist', async () => {
    // `EAI_AGAIN` is a DNS blip. Graded `unresolved` it becomes a recorded verdict ruling a live
    // balancer out, where `failed` leaves the route unruled-out and settles nothing.
    lookup.mockRejectedValue(errno('EAI_AGAIN'))
    await expect(nodeHostResolver({ host: 'alb.example', timeoutMs: 500 })).resolves.toEqual({
      state: 'failed',
      detail: 'EAI_AGAIN',
    })
  })

  it('gives up on its own deadline, and never REJECTS', async () => {
    // `dns.lookup` takes no timeout of its own: it is a threadpool call into the platform resolver
    // and answers when that answers. A hung lookup would otherwise hold the deployer's settle path
    // open for as long as the resolver felt like, and a thrown one would turn a diagnostic into a
    // second way for a healthy run to die.
    const release = hangingLookups()
    await expect(nodeHostResolver({ host: 'slow.example', timeoutMs: 5 })).resolves.toMatchObject({
      state: 'failed',
    })
    await release()
  })

  it('never REJECTS when the lookup throws SYNCHRONOUSLY', async () => {
    // `lookup` validates its arguments before it does anything asynchronous, and that throw used
    // to escape the resolver: past the fail-fast the caller has since dropped, it would have taken
    // the whole route proof down. The port promises this never rejects, which is why the sibling
    // `nodeRouteProbe` wraps `net.connect` the same way.
    lookup.mockImplementation(() => {
      throw errno('ERR_INVALID_ARG_TYPE')
    })
    await expect(nodeHostResolver({ host: 'alb.example', timeoutMs: 5 })).resolves.toEqual({
      state: 'failed',
      detail: 'ERR_INVALID_ARG_TYPE',
    })
  })

  it('never holds more than half the libuv threadpool, whatever the proof asks for', async () => {
    // The deadline abandons a `dns.lookup` that keeps its threadpool thread until the platform
    // resolver gives up, which against a blackholed one is tens of seconds. The pool is four
    // threads by default and `fs` and `crypto` share it, so `MAX_RESOLVED_HOSTS` names started at
    // once could queue every file read and every `pbkdf2` in the server behind a diagnostic.
    const release = hangingLookups()
    const hosts = ['a', 'b', 'c', 'd'].map((name) => `${name}.example`)
    const answers = Promise.all(hosts.map((host) => nodeHostResolver({ host, timeoutMs: 20 })))
    await vi.waitFor(() => expect(lookup).toHaveBeenCalledTimes(2))
    // Every name still answers on its OWN deadline: a caller that never reaches a slot reports
    // "we could not tell", which leaves its candidate unruled-out, rather than waiting for one.
    await expect(answers).resolves.toEqual(
      hosts.map(() => ({ state: 'failed', detail: 'host resolution timed out' })),
    )
    // And the two that never got a slot never started a lookup, which is the point: the gate is
    // what bounds the threads held, so releasing it on the deadline would bound nothing.
    expect(lookup).toHaveBeenCalledTimes(2)
    await release()
  })
})
