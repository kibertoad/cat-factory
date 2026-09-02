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
    lookup.mockReturnValue(new Promise(() => {}))
    await expect(nodeHostResolver({ host: 'slow.example', timeoutMs: 5 })).resolves.toMatchObject({
      state: 'failed',
    })
  })
})
