import type { HostResolveOutcome } from '../ports/host-resolver.js'
import { describe, expect, it } from 'vitest'
import {
  MAX_PROBED_ADDRESSES,
  MAX_RESOLVED_HOSTS,
  describeInconclusiveRoute,
  describeRouteTargets,
  describeUnreachableEnvironment,
  determinateRouteCause,
  planHostResolutions,
  planRouteProbes,
  recordRouteAttempt,
  recordUndialledAttempt,
  reduceRouteProof,
  unprovedRoute,
} from './environment-reachability.logic.js'

const candidates = (...addresses: string[]) => addresses.map((address) => ({ address }))
const hosts = (...names: string[]) => names.map((host) => ({ host }))
const resolved = (...pairs: [string, string[]][]): Map<string, HostResolveOutcome> =>
  new Map(pairs.map(([host, addresses]) => [host, { state: 'resolved', addresses }]))

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

  it('SAYS the plan is a prefix, once, whichever cap shortened it', () => {
    // Every cap here ends the list early, and a prefix nobody is told about is not a cosmetic
    // omission: `reduceRouteProof` grades `not_reached` only when every attempt established
    // something, so a silently shortened list is how the deployer comes to fail a frame on a
    // verdict about candidates the platform never looked at. One entry naming the count, because
    // the reader's question is whether anything was left unlooked-at and N copies of the same
    // admission would crowd the attempt log the real evidence lives in.
    const passedOver = (targets: ReturnType<typeof planRouteProbes>) =>
      targets.filter((t) => t.kind === 'undialled' && t.reason === 'not_attempted')
    // Names beyond the resolution bound: two of the six, and neither was ever looked up.
    const names = planRouteProbes('env.example', 443, hosts('a', 'b', 'c', 'd', 'e', 'f'))
    expect(passedOver(names).map((t) => t.label)).toEqual(['2 further targets the provider stated'])
    // Addresses beyond the dial bound, counted the same way.
    const many = candidates('10.0.0.1', '10.0.0.2', '10.0.0.3', '10.0.0.4', '10.0.0.5')
    expect(passedOver(planRouteProbes('env.example', 443, many)).map((t) => t.label)).toEqual([
      '1 further target the provider stated',
    ])
    // And it is LAST, which keeps the reason a determinate proof reports the FIRST attempt's: the
    // URL's own name, rather than a note about the platform's bounds.
    expect(names.at(-1)).toMatchObject({ reason: 'not_attempted' })
    // A list inside every bound says nothing, because there is nothing to say.
    expect(passedOver(planRouteProbes('env.example', 443, candidates('10.0.0.1')))).toEqual([])
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
    expect(targets.filter((t) => t.kind === 'undialled').map((t) => t.label)).toEqual([
      'env.example@127.0.0.1:443',
      'env.example@169.254.169.254:443',
      'env.example@0:0:0:0:0:0:0:1:443',
    ])
    // A refused target carries NO request, so nothing that iterates the plan can dial it.
    expect(targets.filter((t) => t.kind === 'undialled').every((t) => !('request' in t))).toBe(true)
    // And a dialable address behind four refused ones is still dialled: the refusals cost no I/O,
    // so they may not consume the dial budget.
    expect(targets.filter((t) => t.kind === 'dial').map((t) => t.address)).toEqual([
      null,
      '10.4.19.22',
    ])
  })
})

describe('planHostResolutions', () => {
  it('names the stated HOSTS in the provider order, deduplicated and bounded', () => {
    // Read twice (the caller does the I/O, the plan consumes the answers), so it is stated once
    // here: two copies of this bound is how a name beyond it comes to be reported as a name
    // nothing could resolve.
    expect(
      planHostResolutions([
        { host: 'B.elb.example' },
        { address: '10.4.19.22' },
        { host: 'b.elb.example' },
        { host: 'a.elb.example' },
      ]),
    ).toEqual(['b.elb.example', 'a.elb.example'])
    expect(planHostResolutions(hosts('a', 'b', 'c', 'd', 'e', 'f'))).toHaveLength(
      MAX_RESOLVED_HOSTS,
    )
  })

  it('names nothing for a list of addresses, so nothing is looked up for the ordinary case', () => {
    expect(planHostResolutions(candidates('10.4.19.22'))).toEqual([])
    expect(planHostResolutions()).toEqual([])
  })
})

describe('planRouteProbes with stated NAMES', () => {
  it('expands a name IN PLACE, keeping the provider order across both kinds', () => {
    // In place rather than appended, because the order is the provider's statement about which
    // balancer it wants used and a name is one of the things being ordered.
    const targets = planRouteProbes(
      'env.example',
      443,
      [{ host: 'alb.example' }, { address: '10.4.19.30' }],
      { resolutions: resolved(['alb.example', ['10.4.19.22', '10.4.19.23']]) },
    )
    expect(targets.map((t) => t.label)).toEqual([
      'env.example:443',
      'env.example@10.4.19.22:443 (alb.example)',
      'env.example@10.4.19.23:443 (alb.example)',
      'env.example@10.4.19.30:443',
    ])
  })

  it('carries the stated NAME on the dial target, so a proof can publish which candidate carried', () => {
    // The address is a snapshot of a set that rotates; the name is the target. Without this the
    // fold has nothing to match a REACHED proof against but a literal the next scale event moves.
    const [, first] = planRouteProbes('env.example', 443, hosts('alb.example'), {
      resolutions: resolved(['alb.example', ['10.4.19.22']]),
    })
    expect(first).toMatchObject({ kind: 'dial', address: '10.4.19.22', statedHost: 'alb.example' })
  })

  it('grades a RESOLVED address exactly as a stated one, so a name cannot smuggle a refused target', () => {
    // The safety property, restated for the resolution path: the destination a bridge is built
    // from is still an address the platform itself graded and proved. A name answering with
    // loopback would otherwise re-point a container's own namespace.
    const targets = planRouteProbes('env.example', 443, hosts('evil.example'), {
      resolutions: resolved(['evil.example', ['127.0.0.1', '169.254.169.254', '10.4.19.22']]),
    })
    expect(targets.filter((t) => t.kind === 'undialled').map((t) => t.reason)).toEqual([
      'address_refused',
      'address_refused',
    ])
    expect(targets.filter((t) => t.kind === 'dial').map((t) => t.address)).toEqual([
      null,
      '10.4.19.22',
    ])
  })

  it('dials one literal ONCE, however many names answered with it', () => {
    // Two balancers in one zone routinely answer with an overlapping set, and the dial budget is
    // what the deployer's settle path waits on.
    const targets = planRouteProbes('env.example', 443, hosts('a.example', 'b.example'), {
      resolutions: resolved(['a.example', ['10.4.19.22']], ['b.example', ['10.4.19.22']]),
    })
    expect(targets.filter((t) => t.kind === 'dial').map((t) => t.address)).toEqual([
      null,
      '10.4.19.22',
    ])
  })

  it('records a name that resolved nowhere as a fact about the NAME', () => {
    // Establishes something: that candidate is a dead end, so a proof may settle on it.
    const targets = planRouteProbes('env.example', 443, hosts('alb.example'), {
      resolutions: new Map([['alb.example', { state: 'unresolved' as const }]]),
    })
    expect(targets.filter((t) => t.kind === 'undialled')).toEqual([
      { kind: 'undialled', label: 'env.example@alb.example:443', reason: 'name_unresolved' },
    ])
  })

  it('reads an EMPTY address list as the same fact, never as a lookup that failed', () => {
    const targets = planRouteProbes('env.example', 443, hosts('alb.example'), {
      resolutions: resolved(['alb.example', []]),
    })
    expect(targets.filter((t) => t.kind === 'undialled').map((t) => t.reason)).toEqual([
      'name_unresolved',
    ])
  })

  it('keeps a lookup that FAILED apart from one that answered nothing, with its detail', () => {
    // A resolver outage is "we could not tell", and grading it as a name that does not exist is
    // how a DNS blip becomes a recorded verdict about somebody's environment.
    const targets = planRouteProbes('env.example', 443, hosts('alb.example'), {
      resolutions: new Map([['alb.example', { state: 'failed' as const, detail: 'EAI_AGAIN' }]]),
    })
    expect(targets.filter((t) => t.kind === 'undialled')).toEqual([
      {
        kind: 'undialled',
        label: 'env.example@alb.example:443',
        reason: 'probe_failed',
        detail: 'EAI_AGAIN',
      },
    ])
  })

  it('says a name went unresolved because nothing was WIRED to resolve it', () => {
    // An admission about the deployment, and it must leave the route unruled-out: a facade with no
    // resolver may not start failing deploys for environments it never dialled.
    const targets = planRouteProbes('env.example', 443, hosts('alb.example'))
    const undialled = targets.filter((t) => t.kind === 'undialled')
    expect(undialled.map((t) => t.reason)).toEqual(['resolver_unavailable'])
    expect(
      reduceRouteProof(
        [
          { target: 'env.example:443', outcome: 'name_unresolved' },
          ...undialled.map(recordUndialledAttempt),
        ],
        null,
        1,
      ),
    ).toMatchObject({ state: 'inconclusive', reason: 'resolver_unavailable' })
  })

  it('records a candidate that names NEITHER an address nor a host, rather than dropping it', () => {
    // A shortened list nobody is told about is how a provider's bad candidate becomes an
    // unexplained failure somewhere else.
    const targets = planRouteProbes('env.example', 443, [{ label: 'internal ALB' }])
    expect(targets.filter((t) => t.kind === 'undialled')).toEqual([
      {
        kind: 'undialled',
        label: 'env.example@(no target stated):443',
        reason: 'address_refused',
      },
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
    expect(reduceRouteProof(attempts, { address: '10.4.19.22' }, 5)).toEqual({
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
        recordUndialledAttempt({
          kind: 'undialled',
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

describe('reduceRouteProof for a resolved NAME', () => {
  it('publishes the address that carried AND the stated name it came from', () => {
    const carried = {
      kind: 'dial' as const,
      request: { host: 'env.example', address: '10.4.19.22', port: 443, timeoutMs: 1 },
      address: '10.4.19.22',
      statedHost: 'alb.example',
      label: 'env.example@10.4.19.22:443 (alb.example)',
    }
    expect(
      reduceRouteProof([recordRouteAttempt(carried, { state: 'carried' })], carried, 5),
    ).toMatchObject({ state: 'reached', via: '10.4.19.22', viaHost: 'alb.example' })
  })

  it('carries no `viaHost` for a stated address, so an old proof reads exactly as it did', () => {
    const carried = {
      kind: 'dial' as const,
      request: { host: 'env.example', address: '10.4.19.22', port: 443, timeoutMs: 1 },
      address: '10.4.19.22',
      label: 'env.example@10.4.19.22:443',
    }
    const proof = reduceRouteProof([recordRouteAttempt(carried, { state: 'carried' })], carried, 5)
    expect('viaHost' in proof).toBe(false)
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

describe('describeRouteTargets', () => {
  it('renders every target with its outcome, and its detail where it has one', () => {
    // ONE renderer, exported because three surfaces show this list: the two operator sentences
    // here, the investigation's timeline entry, and the investigation prompt's route section. As
    // three copies of the template, one of them shipped the detail unscrubbed while its neighbour
    // scrubbed it, and a change to the attempt shape had to be found in three packages.
    expect(
      describeRouteTargets([
        { target: 'env.example:443', outcome: 'name_unresolved' },
        { target: 'env.example@10.4.19.22:443', outcome: 'probe_failed', detail: 'EPERM' },
      ]),
    ).toBe('env.example:443 (name_unresolved), env.example@10.4.19.22:443 (probe_failed: EPERM)')
  })

  it('is empty when nothing was tried, so a caller can branch on it', () => {
    expect(describeRouteTargets([])).toBe('')
  })
})

describe('determinateRouteCause', () => {
  const notReached = {
    state: 'not_reached' as const,
    via: null,
    reason: 'name_unresolved',
    attempts: [{ target: 'pr-42.example.test:443', outcome: 'name_unresolved' }],
    checkedAt: 1,
  }

  it('names the cause when the environment name was the only target that ever existed', () => {
    // The whole cause of the motivating failure, and the one the investigation subordinated to a
    // wrong headline: the provider populated no addresses, so the proof had only a name that does
    // not resolve outside an internal DNS view to try.
    const cause = determinateRouteCause([], notReached)
    expect(cause).toContain('stated no addresses and no balancer names')
    expect(cause).toContain('never STATED, not that stated ones were tried and failed')
  })

  it('settles nothing once there were addresses to try', () => {
    // Then the finding is a verdict about the environment or its network, which is exactly the
    // judgement this function must not pre-empt.
    expect(determinateRouteCause([{ address: '10.4.19.22' }], notReached)).toBeNull()
  })

  it('does not claim "no address was stated" when the provider stated several', () => {
    // `no_candidate` is filed whenever the URL yields no host and port, WHATEVER the candidate
    // list holds (`planRouteProbes` needs both before it plans anything). The cause is still
    // determinate and it is a different one: nothing was published to dial the stated addresses
    // ON. Told the provider stated none, a reader goes and fixes a response mapping that is
    // already doing its job, and the prompt is instructed to make this the headline.
    const cause = determinateRouteCause([{ address: '10.4.19.22' }, { address: '10.4.19.23' }], {
      ...notReached,
      state: 'inconclusive',
      reason: 'no_candidate',
      attempts: [],
    })
    expect(cause).toContain('published no URL with a host and port')
    expect(cause).toContain('2 candidates its provider DID state')
    expect(cause).not.toContain('no address or name stated for one')
  })

  it('settles nothing for a proof that CARRIED, or for one that established nothing', () => {
    expect(determinateRouteCause([], { ...notReached, state: 'reached', reason: null })).toBeNull()
    expect(
      determinateRouteCause([], { ...notReached, state: 'inconclusive', reason: 'probe_failed' }),
    ).toBeNull()
    expect(determinateRouteCause([], null)).toBeNull()
  })

  it('names `no_candidate` whatever state carries it, because nothing was published to dial', () => {
    // `reduceRouteProof` files it as `inconclusive` (nothing was tried, so nothing was
    // established), and it is still determinate: the environment published no host and port.
    const cause = determinateRouteCause([], {
      ...notReached,
      state: 'inconclusive',
      reason: 'no_candidate',
      attempts: [],
    })
    expect(cause).toContain('no address to dial at all')
  })
})
