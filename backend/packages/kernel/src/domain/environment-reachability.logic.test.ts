import { describe, expect, it } from 'vitest'
import {
  MAX_PROBED_ADDRESSES,
  describeUnreachableEnvironment,
  planRouteProbes,
  recordRouteAttempt,
  reduceRouteProof,
  unprovedRoute,
} from './environment-reachability.logic.js'

const candidates = (...addresses: string[]) => addresses.map((address) => ({ address }))

describe('planRouteProbes', () => {
  it('tries the NAME first, then each stated address in the provider order', () => {
    // The name first because it is the answer that needs no bridge: a deployment where it works
    // must not start paying for hosts entries and the container replacements they cost. The
    // provider's order after it because the provider is the only thing that knows which of its
    // balancers it wants used.
    expect(
      planRouteProbes('pr-14.test.example.cloud', 443, candidates('10.4.19.22', '10.4.19.23')).map(
        (target) => target.label,
      ),
    ).toEqual([
      'pr-14.test.example.cloud:443',
      'pr-14.test.example.cloud@10.4.19.22:443',
      'pr-14.test.example.cloud@10.4.19.23:443',
    ])
  })

  it('keeps the HOST on every request, including the address ones', () => {
    // The whole reason a bridge maps a name rather than rewriting the URL: the `Host` header a
    // name-based ingress routes on has to stay correct.
    const [, viaAddress] = planRouteProbes(
      'pr-14.test.example.cloud',
      443,
      candidates('10.4.19.22'),
    )
    expect(viaAddress?.request).toMatchObject({
      host: 'pr-14.test.example.cloud',
      address: '10.4.19.22',
      port: 443,
    })
  })

  it('bounds how many stated addresses it will try, and drops duplicates', () => {
    const many = candidates('10.0.0.1', '10.0.0.2', '10.0.0.3', '10.0.0.4', '10.0.0.5', '10.0.0.1')
    expect(planRouteProbes('env.example', 443, many)).toHaveLength(MAX_PROBED_ADDRESSES + 1)
  })

  it('plans nothing when there is no host or port to dial', () => {
    expect(planRouteProbes(null, 443)).toEqual([])
    expect(planRouteProbes('env.example', null)).toEqual([])
  })
})

describe('reduceRouteProof', () => {
  const target = (label: string, address: string | null) => ({
    request: { host: 'env.example', port: 443, timeoutMs: 1 },
    address,
    label,
  })

  it('publishes the address that CARRIED, not the first that was tried', () => {
    const attempts = [
      recordRouteAttempt(target('env.example:443', null), { state: 'unresolved' }),
      recordRouteAttempt(target('env.example@10.4.19.22:443', '10.4.19.22'), { state: 'carried' }),
    ]
    expect(reduceRouteProof(attempts, '10.4.19.22', 5)).toEqual({
      state: 'reached',
      via: '10.4.19.22',
      reason: null,
      attempts: [
        { target: 'env.example:443', outcome: 'name_unresolved' },
        { target: 'env.example@10.4.19.22:443', outcome: 'carried' },
      ],
      checkedAt: 5,
    })
  })

  it('reports the layer the NAME failed at, and keeps every attempt beside it', () => {
    // The first attempt is always the name, so a reader is told what happened to the address they
    // were given rather than what happened to the last balancer in someone's preference list.
    const attempts = [
      recordRouteAttempt(target('env.example:443', null), { state: 'unresolved' }),
      recordRouteAttempt(target('env.example@10.4.19.22:443', '10.4.19.22'), { state: 'no_route' }),
    ]
    const proof = reduceRouteProof(attempts, null, 7)
    expect(proof.state).toBe('not_reached')
    expect(proof.reason).toBe('name_unresolved')
    expect(proof.attempts).toHaveLength(2)
  })

  it('separates a route that carries with nothing listening from one that does not carry', () => {
    // Different faults with different owners: a refused connection is the deployed workload, an
    // unreachable route is the network. Collapsing them is the misreading this all exists to stop.
    const refused = reduceRouteProof(
      [recordRouteAttempt(target('env.example:443', null), { state: 'refused' })],
      null,
      1,
    )
    expect(refused.reason).toBe('connection_refused')
    const noRoute = reduceRouteProof(
      [recordRouteAttempt(target('env.example:443', null), { state: 'no_route' })],
      null,
      1,
    )
    expect(noRoute.reason).toBe('no_route')
  })

  it('never blames DNS for an ADDRESS that would not open', () => {
    // An address is dialled, never looked up, so `unresolved` against one is a probe malfunction.
    // Reported as such rather than as a claim about a zone the reader would then go and check.
    const attempts = [
      recordRouteAttempt(target('env.example@10.4.19.22:443', '10.4.19.22'), {
        state: 'unresolved',
      }),
    ]
    expect(reduceRouteProof(attempts, null, 1).reason).toBe('probe_failed')
  })

  it('says nothing was there to try when nothing was', () => {
    expect(reduceRouteProof([], null, 3)).toMatchObject({
      state: 'not_reached',
      reason: 'no_candidate',
    })
  })
})

describe('unprovedRoute', () => {
  it('is a verdict about the PLATFORM, never about the environment', () => {
    // Collapsing it into `not_reached` would fail runs on a deployment that simply cannot probe;
    // collapsing it into `reached` would hand a tester the unbacked claim this replaces.
    expect(unprovedRoute(9)).toEqual({
      state: 'unproved',
      via: null,
      reason: null,
      attempts: [],
      checkedAt: 9,
    })
  })
})

describe('describeUnreachableEnvironment', () => {
  it('names the layer and every target tried', () => {
    const proof = reduceRouteProof(
      [
        { target: 'env.example:443', outcome: 'name_unresolved' },
        { target: 'env.example@10.4.19.22:443', outcome: 'no_route' },
      ],
      null,
      1,
    )
    const message = describeUnreachableEnvironment('https://env.example', proof)
    expect(message).toContain('https://env.example')
    expect(message).toContain('resolves nowhere')
    expect(message).toContain('env.example@10.4.19.22:443 (no_route)')
  })

  it('degrades to an honest sentence for a reason it does not recognise', () => {
    // The reason rides an open string on the wire, so a proof written by a newer build must render
    // as something rather than splicing `undefined` into an operator's message.
    const message = describeUnreachableEnvironment(null, {
      state: 'not_reached',
      via: null,
      reason: 'something_new',
      attempts: [],
      checkedAt: 1,
    })
    expect(message).toContain('The environment is unreachable')
    expect(message).not.toContain('undefined')
  })
})
