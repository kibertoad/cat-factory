import { describe, expect, it, vi } from 'vitest'
import type { RouteProbeOutcome, RouteProbeRequest } from '@cat-factory/kernel'
import { foldStatedAddresses, proveEnvironmentRoute } from './environmentReachability.js'

const clock = { now: () => 1_000 }

/** A prober answering from a scripted map keyed by what it dialled, defaulting to no route. */
const prober = (answers: Record<string, RouteProbeOutcome>) =>
  vi.fn(
    async (req: RouteProbeRequest) =>
      answers[req.address ?? req.host] ?? ({ state: 'no_route' } as RouteProbeOutcome),
  )

describe('proveEnvironmentRoute', () => {
  it('stops at the first target that carries and publishes THAT one', async () => {
    const probe = prober({
      'pr-14.test.example.cloud': { state: 'unresolved' },
      '10.4.19.22': { state: 'no_route' },
      '10.4.19.23': { state: 'carried' },
    })
    const proof = await proveEnvironmentRoute(
      'https://pr-14.test.example.cloud/health',
      [{ address: '10.4.19.22' }, { address: '10.4.19.23' }, { address: '10.4.19.24' }],
      { probe, clock },
    )
    expect(proof).toMatchObject({ state: 'reached', via: '10.4.19.23' })
    // The fourth candidate is never dialled: the answer is already known, and every extra probe is
    // wall-clock a run that is otherwise ready to proceed spends waiting.
    expect(probe).toHaveBeenCalledTimes(3)
  })

  it('derives the port from the scheme when the URL states none', async () => {
    const probe = prober({ 'env.example': { state: 'carried' } })
    await proveEnvironmentRoute('https://env.example', [], { probe, clock })
    expect(probe.mock.calls[0]?.[0]).toMatchObject({ host: 'env.example', port: 443 })
    const httpProbe = prober({ 'env.example': { state: 'carried' } })
    await proveEnvironmentRoute('http://env.example', [], { probe: httpProbe, clock })
    expect(httpProbe.mock.calls[0]?.[0]).toMatchObject({ port: 80 })
  })

  it('records `unproved` and dials nothing when no prober is wired', async () => {
    // A facade with no socket API behaves exactly as it did before this existed: `unproved` is a
    // verdict about the deployment and never fails a frame.
    expect(await proveEnvironmentRoute('https://env.example', [], { clock })).toMatchObject({
      state: 'unproved',
      attempts: [],
    })
  })

  it('says nothing was there to try for an environment with no usable URL', async () => {
    const probe = prober({})
    for (const url of [null, '', 'not a url']) {
      expect(await proveEnvironmentRoute(url, [], { probe, clock })).toMatchObject({
        state: 'not_reached',
        reason: 'no_candidate',
      })
    }
    expect(probe).not.toHaveBeenCalled()
  })
})

describe('foldStatedAddresses', () => {
  const proof = {
    state: 'reached' as const,
    via: '10.4.19.22',
    reason: null,
    attempts: [],
    checkedAt: 1,
  }

  it('keeps the proof while the URL and the candidate list are both unchanged', () => {
    expect(
      foldStatedAddresses(
        { candidates: [{ address: '10.4.19.22' }], proof },
        'https://env.example',
        [{ address: '10.4.19.22', label: 'internal ALB' }],
        'https://env.example',
      ),
    ).toEqual({ candidates: [{ address: '10.4.19.22', label: 'internal ALB' }], proof })
  })

  it('drops the proof when the URL moves', () => {
    // The stored verdict is about a target that no longer exists; keeping it is how a stale
    // `reached` comes to vouch for an address nobody has dialled at the new name.
    expect(
      foldStatedAddresses(
        { candidates: [{ address: '10.4.19.22' }], proof },
        'https://env.example',
        [{ address: '10.4.19.22' }],
        'https://moved.example',
      )?.proof,
    ).toBeNull()
  })

  it('drops the proof when the provider re-states a different candidate list', () => {
    expect(
      foldStatedAddresses(
        { candidates: [{ address: '10.4.19.22' }], proof },
        'https://env.example',
        [{ address: '10.4.19.99' }],
        'https://env.example',
      )?.proof,
    ).toBeNull()
  })

  it('is null when there is nothing worth a column', () => {
    expect(foldStatedAddresses(null, null, [], 'https://env.example')).toBeNull()
    expect(foldStatedAddresses(null, null, undefined, null)).toBeNull()
  })
})
