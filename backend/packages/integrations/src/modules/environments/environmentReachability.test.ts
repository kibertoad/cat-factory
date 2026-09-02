import { describe, expect, it, vi } from 'vitest'
import type { HostResolveRequest, RouteProbeOutcome, RouteProbeRequest } from '@cat-factory/kernel'
import {
  foldStatedAddresses,
  proveEnvironmentRoute,
  ROUTE_REPROVE_MIN_INTERVAL_MS,
  routeReproveDecision,
} from './environmentReachability.js'

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

describe('proveEnvironmentRoute with stated NAMES', () => {
  it('resolves each stated name ONCE and dials what it answered with, in the plan order', async () => {
    const probe = prober({
      'pr-14.test.example.cloud': { state: 'unresolved' },
      '10.4.19.22': { state: 'no_route' },
      '10.4.19.23': { state: 'carried' },
    })
    const resolveHost = vi.fn(async (_req: HostResolveRequest) => ({
      state: 'resolved' as const,
      addresses: ['10.4.19.22', '10.4.19.23'],
    }))
    const proof = await proveEnvironmentRoute(
      'https://pr-14.test.example.cloud/health',
      [{ host: 'ALB-4.elb.example', label: 'public ALB' }],
      { probe, resolveHost, clock },
    )
    // Lower-cased once, by the shared classifier, so two spellings of one balancer are one lookup.
    expect(resolveHost).toHaveBeenCalledTimes(1)
    expect(resolveHost.mock.calls[0]?.[0]).toMatchObject({ host: 'alb-4.elb.example' })
    expect(proof).toMatchObject({
      state: 'reached',
      via: '10.4.19.23',
      viaHost: 'alb-4.elb.example',
    })
    // The attempt names BOTH, because the address alone cannot be traced back to the candidate a
    // reader is looking at and the name alone is not what was dialled.
    expect(proof.attempts.at(-1)?.target).toBe(
      'pr-14.test.example.cloud@10.4.19.23:443 (alb-4.elb.example)',
    )
  })

  it('resolves NOTHING when no prober is wired, because nothing would be dialled with it', async () => {
    const resolveHost = vi.fn(async () => ({ state: 'unresolved' as const }))
    const proof = await proveEnvironmentRoute(
      'https://pr-14.test.example.cloud',
      [{ host: 'alb-4.elb.example' }],
      { resolveHost, clock },
    )
    expect(resolveHost).not.toHaveBeenCalled()
    expect(proof.state).toBe('unproved')
  })

  it('says a stated name went undialled because nothing was WIRED to resolve it', async () => {
    // An admission about the DEPLOYMENT, never a verdict about the environment: a facade with no
    // resolver has not ruled the candidate out, it has declined to look at it. Graded as a verdict
    // it would fail every deploy of a name-fronted environment on such a deployment.
    const proof = await proveEnvironmentRoute(
      'https://pr-14.test.example.cloud',
      [{ host: 'alb-4.elb.example' }],
      { probe: prober({ 'pr-14.test.example.cloud': { state: 'unresolved' } }), clock },
    )
    expect(proof).toMatchObject({ state: 'inconclusive', reason: 'resolver_unavailable' })
    expect(proof.attempts.map((a) => a.outcome)).toEqual([
      'name_unresolved',
      'resolver_unavailable',
    ])
  })

  it('falls through to the next candidate when one name resolves nowhere', async () => {
    // Per candidate, exactly as a refused address is: one balancer being retired does not make the
    // environment unreachable, and the fall-through is what the module already does per target.
    const probe = prober({
      'pr-14.test.example.cloud': { state: 'unresolved' },
      '10.4.19.30': { state: 'carried' },
    })
    const proof = await proveEnvironmentRoute(
      'https://pr-14.test.example.cloud',
      [{ host: 'gone.elb.example' }, { host: 'live.elb.example' }],
      {
        probe,
        resolveHost: async (req) =>
          req.host === 'gone.elb.example'
            ? { state: 'unresolved' }
            : { state: 'resolved', addresses: ['10.4.19.30'] },
        clock,
      },
    )
    expect(proof.attempts.map((a) => a.outcome)).toEqual([
      'name_unresolved',
      'name_unresolved',
      'carried',
    ])
    expect(proof).toMatchObject({ state: 'reached', via: '10.4.19.30' })
  })

  it('costs one NAME its answer when the resolver rejects, never the whole proof', async () => {
    // The port says a resolver never rejects and nothing can enforce it: a facade adapter with an
    // unguarded leg, or one a deployment supplies, would take `proveEnvironmentRoute` down with
    // it, and the status poll's fold is not best-effort, so the whole poll would throw and leave
    // the environment stuck at whatever it last said. A rejection is the same fact as a lookup
    // that `failed`: we could not tell, so the candidate is not ruled out.
    const probe = prober({
      'pr-14.test.example.cloud': { state: 'unresolved' },
      '10.4.19.30': { state: 'carried' },
    })
    const proof = await proveEnvironmentRoute(
      'https://pr-14.test.example.cloud',
      [{ host: 'broken.elb.example' }, { host: 'live.elb.example' }],
      {
        probe,
        resolveHost: async (req) => {
          if (req.host === 'broken.elb.example') throw new Error('resolver adapter blew up')
          return { state: 'resolved', addresses: ['10.4.19.30'] }
        },
        clock,
      },
    )
    expect(proof.attempts.map((a) => a.outcome)).toEqual([
      'name_unresolved',
      'probe_failed',
      'carried',
    ])
    expect(proof.attempts[1]?.detail).toContain('resolver adapter blew up')
    expect(proof).toMatchObject({ state: 'reached', via: '10.4.19.30' })
  })

  it('looks up NOTHING for an environment with no host and port to dial', async () => {
    // The plan is empty for those coordinates whatever the answers say, so the lookups would be up
    // to `MAX_RESOLVED_HOSTS` timeouts nobody reads: on the settle path, and again on every status
    // poll that re-proves.
    const resolveHost = vi.fn(async () => ({ state: 'unresolved' as const }))
    const probe = prober({})
    const proof = await proveEnvironmentRoute(null, [{ host: 'alb-4.elb.example' }], {
      probe,
      resolveHost,
      clock,
    })
    expect(resolveHost).not.toHaveBeenCalled()
    expect(probe).not.toHaveBeenCalled()
    expect(proof).toMatchObject({ state: 'inconclusive', reason: 'no_candidate' })
  })

  it('never grades a verdict against a name it stopped short of looking up', async () => {
    // The platform resolves a bounded number of names. Past that bound the candidate is passed
    // over, so nothing is established about it, so the list cannot add up to "nothing reaches this
    // environment", the verdict that fails the deployer's frame.
    const names = ['a', 'b', 'c', 'd', 'e'].map((name) => ({ host: `${name}.elb.example` }))
    const proof = await proveEnvironmentRoute('https://env.example', names, {
      probe: prober({ 'env.example': { state: 'unresolved' } }),
      resolveHost: async () => ({ state: 'unresolved' }),
      clock,
    })
    expect(proof.attempts.map((a) => a.outcome)).toEqual([
      'name_unresolved',
      'name_unresolved',
      'name_unresolved',
      'name_unresolved',
      'name_unresolved',
      'not_attempted',
    ])
    expect(proof.attempts.at(-1)).toMatchObject({ target: '1 further target the provider stated' })
    expect(proof).toMatchObject({ state: 'inconclusive', reason: 'not_attempted' })
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
      // `probedAt` rides along, carried from the proof's own date: it says when the platform last
      // LOOKED, which is what survives a verdict the next poll has to drop.
    ).toEqual({
      candidates: [{ address: '10.4.19.22', label: 'internal ALB' }],
      proof,
      probedAt: proof.checkedAt,
    })
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
      probedAt: proof.checkedAt,
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
      probedAt: proof.checkedAt,
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
      // Both halves gone and the value still worth a column, because the third one is the record
      // that something DID look: a poll that drops a proof and then paces its re-take against a
      // date the drop erased would never re-take anything.
    ).toEqual({ candidates: [], proof: null, probedAt: proof.checkedAt })
  })

  it('normalizes an address the same way the PROBE does before matching a proof', () => {
    // `planRouteProbes` trims before it dials, so `via` is a trimmed value. Compared against a raw
    // stored candidate, a provider stating a padded address proved one string and stored another,
    // so a good `reached` proof was dropped on every poll and re-probed on every poll. The
    // manifest provider trims on capture, which is why this only ever bit an adapter that states
    // addresses directly.
    expect(
      foldStatedAddresses(
        { candidates: [{ address: ' 10.4.19.22' }], proof },
        'https://env.example',
        [{ address: ' 10.4.19.22' }],
        'https://env.example',
      )?.proof,
    ).toEqual(proof)
  })
})

describe('foldStatedAddresses across a resolved NAME', () => {
  const reachedVia = (via: string, viaHost?: string) => ({
    candidates: [{ host: 'alb-4.elb.example' }],
    proof: {
      state: 'reached' as const,
      via,
      ...(viaHost ? { viaHost } : {}),
      reason: null,
      attempts: [],
      checkedAt: 10,
    },
  })

  it('keeps a proof taken through a name while the NAME is still stated, whatever it resolves to now', () => {
    // The whole reason `viaHost` is recorded. A balancer that scaled or gained a zone answers with
    // a different address set, which is a routine event that says nothing about whether the proved
    // route carries; matching the stored address against the candidate list would drop the proof on
    // every one of them and pay a fresh probe sequence for it.
    const folded = foldStatedAddresses(
      reachedVia('10.4.19.23', 'alb-4.elb.example'),
      'https://env.example',
      [{ host: 'alb-4.elb.example', label: 'public ALB' }],
      'https://env.example',
    )
    expect(folded?.proof).toMatchObject({ via: '10.4.19.23', viaHost: 'alb-4.elb.example' })
  })

  it('drops it once the provider stops stating that name', () => {
    const folded = foldStatedAddresses(
      reachedVia('10.4.19.23', 'alb-4.elb.example'),
      'https://env.example',
      [{ host: 'alb-9.elb.example' }],
      'https://env.example',
    )
    expect(folded?.proof).toBeNull()
  })

  it('reads a proof with no viaHost as the ADDRESS case, which is what it was', () => {
    // A proof written before names existed. It must behave byte-for-byte as it did, which means
    // matching `via` against the stated ADDRESSES and never against a name that reads alike.
    expect(
      foldStatedAddresses(
        reachedVia('10.4.19.23'),
        'https://env.example',
        [{ address: '10.4.19.23' }],
        'https://env.example',
      )?.proof,
    ).toMatchObject({ via: '10.4.19.23' })
    expect(
      foldStatedAddresses(
        reachedVia('alb-4.elb.example'),
        'https://env.example',
        [{ host: 'alb-4.elb.example' }],
        'https://env.example',
      )?.proof,
    ).toBeNull()
  })

  it('sees the NUMBER of candidates naming nothing change, which a set cannot', () => {
    // Every entry naming no target collapses onto one key, because there is nothing to key it by.
    // Folded into a set, four of them look like one: a provider that starts stating an extra
    // unusable entry would keep a stale `not_reached` proof while `planRouteProbes` records one
    // more `address_refused` attempt than that proof knows about.
    const negative = {
      state: 'not_reached' as const,
      via: null,
      reason: 'address_refused',
      attempts: [],
      checkedAt: 10,
    }
    const stored = { candidates: [{ address: '10.4.19.22' }, {}], proof: negative }
    expect(
      foldStatedAddresses(
        stored,
        'https://env.example',
        [{ address: '10.4.19.22' }, {}, { label: 'stated with no target' }],
        'https://env.example',
      )?.proof,
    ).toBeNull()
    // The same count still keeps it: an unusable entry renders identically wherever it sits, so
    // reordering one is not something a proof could be a finding about.
    expect(
      foldStatedAddresses(
        stored,
        'https://env.example',
        [{}, { address: '10.4.19.22' }],
        'https://env.example',
      )?.proof,
    ).toEqual(negative)
  })

  it('treats a name and an address that read alike as two candidates in the SET comparison', () => {
    const stored = {
      candidates: [{ host: 'alb-4.elb.example' }],
      proof: {
        state: 'not_reached' as const,
        via: null,
        reason: 'name_unresolved',
        attempts: [],
        checkedAt: 10,
      },
    }
    const folded = foldStatedAddresses(
      stored,
      'https://env.example',
      [{ address: 'alb-4.elb.example' }],
      'https://env.example',
    )
    expect(folded?.proof).toBeNull()
  })
})

describe('routeReproveDecision', () => {
  const reached = {
    state: 'reached' as const,
    via: '10.4.19.22',
    reason: null,
    attempts: [],
    checkedAt: 1_000,
  }
  const at = (now: number) => now

  it('re-proves a dropped proof once the interval has passed', () => {
    expect(
      routeReproveDecision({
        stored: { candidates: [{ address: '10.4.19.22' }], proof: reached },
        folded: { candidates: [{ address: '10.4.19.30' }], proof: null, probedAt: 1_000 },
        ready: true,
        canResolveHosts: true,
        now: at(1_000 + ROUTE_REPROVE_MIN_INTERVAL_MS),
      }),
    ).toBe('reprove')
  })

  it('HOLDS a re-prove while the last look is inside the interval', () => {
    // The bound. This decision is taken on a ten-second poll cadence, and a proof costs up to five
    // sequential dials at four seconds each, so an environment whose provider re-states a
    // different candidate set on every answer would spend twenty seconds per poll on probes.
    expect(
      routeReproveDecision({
        stored: { candidates: [{ address: '10.4.19.22' }], proof: reached },
        folded: { candidates: [{ address: '10.4.19.30' }], proof: null, probedAt: 1_000 },
        ready: true,
        canResolveHosts: true,
        now: at(1_000 + ROUTE_REPROVE_MIN_INTERVAL_MS - 1),
      }),
    ).toBe('held')
  })

  it('paces itself off `probedAt`, which is what survives a HELD drop', () => {
    // The trap the anchor exists for: a hold persists the drop, so a decision anchored on the
    // proof's own date would find nothing to measure against on the very next poll and answer
    // `keep` forever, leaving the environment permanently unproved with nothing saying why.
    expect(
      routeReproveDecision({
        stored: { candidates: [{ address: '10.4.19.30' }], proof: null, probedAt: 1_000 },
        folded: { candidates: [{ address: '10.4.19.31' }], proof: null, probedAt: 1_000 },
        ready: true,
        canResolveHosts: true,
        now: at(1_000 + ROUTE_REPROVE_MIN_INTERVAL_MS),
      }),
    ).toBe('reprove')
  })

  it('replaces a stored `unproved` proof, which is a proof never TAKEN', () => {
    // It survives the fold forever on set equality, so read as a live proof it left every
    // environment settled before a deployment wired its prober permanently unproved.
    const unproved = { ...reached, state: 'unproved' as const, via: null }
    expect(
      routeReproveDecision({
        stored: { candidates: [{ address: '10.4.19.22' }], proof: unproved },
        folded: { candidates: [{ address: '10.4.19.22' }], proof: unproved, probedAt: 1_000 },
        ready: true,
        canResolveHosts: true,
        now: at(1_000 + ROUTE_REPROVE_MIN_INTERVAL_MS),
      }),
    ).toBe('reprove')
  })

  it('keeps a proof that still establishes something, and never takes the FIRST look', () => {
    expect(
      routeReproveDecision({
        stored: { candidates: [{ address: '10.4.19.22' }], proof: reached },
        folded: { candidates: [{ address: '10.4.19.22' }], proof: reached, probedAt: 1_000 },
        ready: true,
        canResolveHosts: true,
        now: at(9_000_000),
      }),
    ).toBe('keep')
    // Nothing has ever looked: the deployer's settle path owns that one, and probing here would
    // dial on every poll of every environment whose frame has not settled.
    expect(
      routeReproveDecision({
        stored: { candidates: [{ address: '10.4.19.22' }], proof: null },
        folded: { candidates: [{ address: '10.4.19.22' }], proof: null },
        ready: true,
        canResolveHosts: true,
        now: at(9_000_000),
      }),
    ).toBe('keep')
    // And an environment that has gone back to `provisioning` is not worth dialling yet.
    expect(
      routeReproveDecision({
        stored: { candidates: [{ address: '10.4.19.22' }], proof: reached },
        folded: { candidates: [{ address: '10.4.19.30' }], proof: null, probedAt: 1_000 },
        ready: false,
        canResolveHosts: true,
        now: at(9_000_000),
      }),
    ).toBe('keep')
  })

  it('re-takes a `resolver_unavailable` proof once a resolver is WIRED, and not before', () => {
    // The `unproved` trap in the shape the rule above cannot see. The proof is `inconclusive`, so
    // it is not `unproved`, and it survives the fold forever on set equality: left alone it would
    // leave an environment settled by a facade with no resolver unproved for the life of the
    // environment, including after the deployment wired one.
    const unavailable = {
      state: 'inconclusive' as const,
      via: null,
      reason: 'resolver_unavailable',
      attempts: [{ target: 'env.example@alb-4.elb.example:443', outcome: 'resolver_unavailable' }],
      checkedAt: 1_000,
    }
    const args = {
      stored: { candidates: [{ host: 'alb-4.elb.example' }], proof: unavailable },
      folded: {
        candidates: [{ host: 'alb-4.elb.example' }],
        proof: unavailable,
        probedAt: 1_000,
      },
      ready: true,
      now: at(1_000 + ROUTE_REPROVE_MIN_INTERVAL_MS),
    }
    expect(routeReproveDecision({ ...args, canResolveHosts: true })).toBe('reprove')
    // With nothing still wired the re-probe would pay a full dial sequence a minute to re-derive
    // the answer it already has.
    expect(routeReproveDecision({ ...args, canResolveHosts: false })).toBe('keep')
  })

  it('refreshes a `reached` proof whose `via` was RESOLVED from a name', () => {
    // `via` is the literal a container host bridge is built from, and for a resolved name it is a
    // snapshot of an address set the platform does not own. The balancer rescaling this proof
    // deliberately SURVIVES is the same event that releases that address, so left alone the row
    // goes on publishing a bridge target the vendor has since handed to someone else.
    const viaName = { ...reached, via: '10.4.19.23', viaHost: 'alb-4.elb.example' }
    const args = {
      stored: { candidates: [{ host: 'alb-4.elb.example' }], proof: viaName },
      folded: { candidates: [{ host: 'alb-4.elb.example' }], proof: viaName, probedAt: 1_000 },
      ready: true,
      canResolveHosts: true,
    }
    expect(routeReproveDecision({ ...args, now: at(1_000 + ROUTE_REPROVE_MIN_INTERVAL_MS) })).toBe(
      'reprove',
    )
    // Paced by the same bound as every other re-take, so a polled environment cannot spend a dial
    // sequence per poll on a proof it already has.
    expect(
      routeReproveDecision({ ...args, now: at(1_000 + ROUTE_REPROVE_MIN_INTERVAL_MS - 1) }),
    ).toBe('held')
  })
})
