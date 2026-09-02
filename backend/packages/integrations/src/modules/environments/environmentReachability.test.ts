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

  it('says nothing was there to try for an environment with no usable URL, and FAILS nothing', async () => {
    // A `ready` environment with no URL is a legitimate outcome (a service that declares no
    // ingress), and so is one on a scheme with no port to derive. `inconclusive` is what keeps the
    // deployer out of it: graded `not_reached` this failed every such deploy, which is exactly the
    // "diagnostic becomes a second way to die" failure the feature must not have.
    const probe = prober({})
    for (const url of [null, '', 'not a url', 'ftp://env.example']) {
      expect(await proveEnvironmentRoute(url, [], { probe, clock })).toMatchObject({
        state: 'inconclusive',
        reason: 'no_candidate',
      })
    }
    expect(probe).not.toHaveBeenCalled()
  })

  it('is inconclusive, never a failure, when the probe could not classify its own failure', async () => {
    const probe = prober({ 'env.example': { state: 'failed', detail: 'ECONNRESET' } })
    const proof = await proveEnvironmentRoute('https://env.example', [], { probe, clock })
    expect(proof).toMatchObject({ state: 'inconclusive', reason: 'probe_failed' })
    // And the probe's own message survives onto the attempt, which is the only thing that can tell
    // a runtime restriction from a resolver fault from a bug in the probe.
    expect(proof.attempts[0]).toMatchObject({ outcome: 'probe_failed', detail: 'ECONNRESET' })
  })

  it('RECORDS an address it will not dial, and never opens a socket to it', async () => {
    // The safety property: `addresses` is provider-authored, so an unfiltered probe would dial
    // loopback and the metadata endpoint on a manifest's say-so and record the answers on a row a
    // workspace reads back. Recorded rather than dropped, so the omission is visible.
    const probe = prober({ 'env.example': { state: 'unresolved' } })
    const proof = await proveEnvironmentRoute(
      'https://env.example',
      [{ address: '169.254.169.254' }, { address: '127.0.0.1' }],
      { probe, clock },
    )
    expect(probe).toHaveBeenCalledTimes(1)
    expect(proof.attempts.map((a) => a.outcome)).toEqual([
      'name_unresolved',
      'address_refused',
      'address_refused',
    ])
    // The name did not resolve and no address was usable: the environment really is unreachable.
    expect(proof.state).toBe('not_reached')
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

  it('keeps a `reached` proof when the same addresses come back in a different ORDER', () => {
    // The latent trap this rule replaced. A provider stating addresses from a live DNS answer is
    // stating a value whose order it does not control: `getaddrinfo` sorts destinations against
    // the local interface set, and resolvers rotate records between answers. A sequence
    // comparison dropped the proof on a network change, months later, on someone else's machine,
    // and nothing took another one, so the address a container bridge is built from just stopped.
    expect(
      foldStatedAddresses(
        { candidates: [{ address: '10.4.19.22' }, { address: '10.4.19.23' }], proof },
        'https://env.example',
        [{ address: '10.4.19.23' }, { address: '10.4.19.22' }],
        'https://env.example',
      ),
    ).toEqual({
      // The FRESH order is kept for the next probe: it is the provider's current preference about
      // what to try first. It is just not evidence.
      candidates: [{ address: '10.4.19.23' }, { address: '10.4.19.22' }],
      proof,
    })
  })

  it('keeps a `reached` proof when the provider ADDS a candidate it never touched', () => {
    // Strictly more information cannot invalidate a finding about one address. A balancer gaining
    // a zone is a routine event and says nothing about whether the proved address still carries.
    expect(
      foldStatedAddresses(
        { candidates: [{ address: '10.4.19.22' }], proof },
        'https://env.example',
        [{ address: '10.4.19.22' }, { address: '10.4.19.30', label: 'new AZ' }],
        'https://env.example',
      )?.proof,
    ).toEqual(proof)
  })

  it('keeps a `reached` proof taken on the NAME itself whatever the candidates do', () => {
    // `via: null` on a `reached` proof means the name carried, so the candidate list was never
    // part of the finding; the URL is what it was about and the URL is checked above.
    const byName = { ...proof, via: null }
    expect(
      foldStatedAddresses(
        { candidates: [{ address: '10.4.19.22' }], proof: byName },
        'https://env.example',
        [{ address: '10.4.19.30' }],
        'https://env.example',
      )?.proof,
    ).toEqual(byName)
  })

  it('DROPS a negative proof once a candidate it never dialled appears', () => {
    // The asymmetry is the point: "nothing reaches this environment" is a finding about the whole
    // list that was tried, so it stops being established the moment there is a target nothing
    // tried. A reorder of the same SET leaves it standing (below).
    const negative = { ...proof, state: 'not_reached' as const, via: null, reason: 'no_route' }
    expect(
      foldStatedAddresses(
        { candidates: [{ address: '10.4.19.22' }], proof: negative },
        'https://env.example',
        [{ address: '10.4.19.22' }, { address: '10.4.19.30' }],
        'https://env.example',
      )?.proof,
    ).toBeNull()
    expect(
      foldStatedAddresses(
        { candidates: [{ address: '10.4.19.22' }, { address: '10.4.19.30' }], proof: negative },
        'https://env.example',
        [{ address: '10.4.19.30' }, { address: '10.4.19.22' }],
        'https://env.example',
      )?.proof,
    ).toEqual(negative)
  })

  it('is null when there is nothing worth a column', () => {
    expect(foldStatedAddresses(null, null, [], 'https://env.example')).toBeNull()
    expect(foldStatedAddresses(null, null, undefined, null)).toBeNull()
  })

  it('KEEPS the stored candidates when a response states nothing about addresses', () => {
    // Absent is not empty, and conflating them is a hard failure rather than a lost nicety: an
    // async provider states its balancer list on the CREATE response and answers `{state, url}`
    // from its status endpoint, so every readiness poll would erase the candidate list before the
    // proof ever ran, leaving it to dial only the name it already knows resolves nowhere.
    expect(
      foldStatedAddresses(
        { candidates: [{ address: '10.4.19.22' }, { address: '10.4.19.23' }], proof },
        'https://env.example',
        undefined,
        'https://env.example',
      ),
    ).toEqual({
      candidates: [{ address: '10.4.19.22' }, { address: '10.4.19.23' }],
      proof,
    })
  })

  it('replaces them when the provider DOES state a list, empty included', () => {
    // A manifest that declares an `addressesPath` answering with nothing is a provider saying
    // "none", which is a statement, and it drops the proof beside it: the verdict was about a
    // candidate the provider no longer offers.
    expect(
      foldStatedAddresses(
        { candidates: [{ address: '10.4.19.22' }], proof },
        'https://env.example',
        [],
        'https://env.example',
      ),
    ).toBeNull()
  })
})
