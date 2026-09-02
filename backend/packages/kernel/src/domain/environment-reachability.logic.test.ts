import { describe, expect, it } from 'vitest'
import {
  MAX_PROBED_ADDRESSES,
  describeInconclusiveRoute,
  describeUnreachableEnvironment,
  planRouteProbes,
  recordRefusedAttempt,
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
    expect(viaAddress?.kind === 'dial' && viaAddress.request).toMatchObject({
      host: 'pr-14.test.example.cloud',
      address: '10.4.19.22',
      port: 443,
    })
  })

  it('bounds how many stated addresses it will DIAL, and drops duplicates', () => {
    const many = candidates('10.0.0.1', '10.0.0.2', '10.0.0.3', '10.0.0.4', '10.0.0.5', '10.0.0.1')
    const dialable = planRouteProbes('env.example', 443, many).filter((t) => t.kind === 'dial')
    expect(dialable).toHaveLength(MAX_PROBED_ADDRESSES + 1)
  })

  it('plans nothing when there is no host or port to dial', () => {
    expect(planRouteProbes(null, 443)).toEqual([])
    expect(planRouteProbes('env.example', null)).toEqual([])
  })

  it('REFUSES to dial an address a bridge may not name, and says so instead of dropping it', () => {
    // The safety property of the whole probe. `addresses` is provider-authored data, so with no
    // rule here the orchestrator opens sockets wherever a manifest points and records the answers
    // on a row a workspace reads back: a liveness oracle against the deployment's own network. It
    // costs nothing real either, since an address no bridge may name is one no container could be
    // pointed at. Refused rather than silently shortened, so the omission is on the proof.
    const targets = planRouteProbes(
      'env.example',
      443,
      candidates('127.0.0.1', '169.254.169.254', '0:0:0:0:0:0:0:1', '10.4.19.22'),
    )
    expect(targets.filter((t) => t.kind === 'refused').map((t) => t.address)).toEqual([
      '127.0.0.1',
      '169.254.169.254',
      '0:0:0:0:0:0:0:1',
    ])
    // A refused target carries NO request, so nothing that iterates the plan can dial it.
    expect(targets.filter((t) => t.kind === 'refused').every((t) => !('request' in t))).toBe(true)
    // And a dialable address behind four refused ones is still dialled: the refusals cost no I/O,
    // so they may not consume the dial budget.
    expect(targets.filter((t) => t.kind === 'dial').map((t) => t.address)).toEqual([
      null,
      '10.4.19.22',
    ])
  })
})

describe('reduceRouteProof', () => {
  const target = (label: string, address: string | null) =>
    ({
      kind: 'dial',
      request: { host: 'env.example', port: 443, timeoutMs: 1 },
      address,
      label,
    }) as const

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

  it('is INCONCLUSIVE, never `not_reached`, when a probe could not classify its own failure', () => {
    // The disposition that decides whether the diagnostic can kill a healthy deploy. Only
    // `not_reached` fails a deployer frame, and `probe_failed` is where a workerd connect message
    // matching none of that facade's markers and a Node errno outside the mapped five both land:
    // reading either as a verdict about the environment fails runs on a wording change.
    const proof = reduceRouteProof(
      [
        recordRouteAttempt(target('env.example:443', null), {
          state: 'failed',
          detail: 'ECONNRESET',
        }),
      ],
      null,
      2,
    )
    expect(proof.state).toBe('inconclusive')
    expect(proof.reason).toBe('probe_failed')
  })

  it('is inconclusive when ANY attempt left a route unruled-out, not only the first', () => {
    // The name genuinely did not resolve, but the address probe malfunctioned, so a route the
    // platform never ruled out remains. The reason names the attempt that left it unknown rather
    // than the name's own verdict, which would read as a settled finding.
    const proof = reduceRouteProof(
      [
        recordRouteAttempt(target('env.example:443', null), { state: 'unresolved' }),
        recordRouteAttempt(target('env.example@10.4.19.22:443', '10.4.19.22'), {
          state: 'failed',
          detail: 'blocked',
        }),
      ],
      null,
      2,
    )
    expect(proof.state).toBe('inconclusive')
    expect(proof.reason).toBe('probe_failed')
  })

  it('still FAILS on a refused address beside a name that did not resolve', () => {
    // A refused address is a decision, not an unknown: no bridge may name it, so no container
    // could have been pointed at it either. The environment really is unreachable.
    const proof = reduceRouteProof(
      [
        recordRouteAttempt(target('env.example:443', null), { state: 'unresolved' }),
        recordRefusedAttempt({
          kind: 'refused',
          address: '127.0.0.1',
          label: 'env.example@127.0.0.1:443',
          reason: 'address_refused',
        }),
      ],
      null,
      2,
    )
    expect(proof.state).toBe('not_reached')
    expect(proof.reason).toBe('name_unresolved')
  })

  it('treats an outcome it does not recognise as leaving the route unknown', () => {
    // A proof written by a newer build. The unreadable direction has to be the one that cannot
    // turn a value this build cannot interpret into a failed deploy.
    const proof = reduceRouteProof(
      [{ target: 'env.example:443', outcome: 'something_new' }],
      null,
      1,
    )
    expect(proof.state).toBe('inconclusive')
  })

  it('says nothing was there to try when nothing was, WITHOUT failing anything', () => {
    // A `ready` environment with no URL is a legitimate outcome (a service that declares no
    // ingress), and `no_candidate` means "there was nothing to try", which is not the same fact as
    // trying and failing. Graded `not_reached` it failed every such deploy.
    expect(reduceRouteProof([], null, 3)).toMatchObject({
      state: 'inconclusive',
      reason: 'no_candidate',
    })
  })
})

describe('recordRouteAttempt', () => {
  const dial = {
    kind: 'dial',
    request: { host: 'env.example', port: 443, timeoutMs: 1 },
    address: null,
    label: 'env.example:443',
  } as const

  it('keeps the probe DETAIL for the one outcome that names no layer', () => {
    // `probe_failed` says "we could not tell" by design, so its detail is the only thing that
    // separates a resolver fault from a runtime restriction from a bug in the probe.
    expect(recordRouteAttempt(dial, { state: 'failed', detail: 'ETIMEDOUT on handshake' })).toEqual(
      {
        target: 'env.example:443',
        outcome: 'probe_failed',
        detail: 'ETIMEDOUT on handshake',
      },
    )
  })

  it('caps the detail, because it lands in an operator message and an agent prompt', () => {
    const attempt = recordRouteAttempt(dial, { state: 'failed', detail: 'x'.repeat(500) })
    expect(attempt.detail?.length).toBe(200)
  })

  it('records no detail for an outcome that already names its layer', () => {
    expect(recordRouteAttempt(dial, { state: 'refused' })).toEqual({
      target: 'env.example:443',
      outcome: 'connection_refused',
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

  it('quotes an attempt DETAIL, so a reader is not told only that something went wrong', () => {
    const message = describeUnreachableEnvironment('https://env.example', {
      state: 'not_reached',
      via: null,
      reason: 'name_unresolved',
      attempts: [{ target: 'env.example:443', outcome: 'probe_failed', detail: 'ECONNRESET' }],
      checkedAt: 1,
    })
    expect(message).toContain('env.example:443 (probe_failed: ECONNRESET)')
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

describe('describeInconclusiveRoute', () => {
  it('claims nothing about the environment, and says which targets were tried', () => {
    // Read beside a run that CONTINUED, so it may not say "unreachable" and may not name a layer
    // as the fault: the platform could not tell, and that is the whole content.
    const message = describeInconclusiveRoute(
      'https://env.example',
      reduceRouteProof([{ target: 'env.example:443', outcome: 'probe_failed' }], null, 1),
    )
    expect(message).toContain('could not be established either way')
    expect(message).toContain('env.example:443 (probe_failed)')
    expect(message).not.toContain('is unreachable')
  })
})
