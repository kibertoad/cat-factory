import type { InfraSetup, Notification } from '@cat-factory/contracts'
import { describe, expect, it } from 'vitest'
import {
  applyInfraReachability,
  decideReachability,
  type ProbeOutcome,
  recordedUnreachableAreas,
} from './infra-reachability.js'

const card = (unreachableAreas?: string[]): Notification =>
  ({
    id: 'ntf_1',
    type: 'infra_unreachable',
    status: 'open',
    severity: 'normal',
    blockId: null,
    executionId: null,
    title: 't',
    body: 'b',
    payload: unreachableAreas ? { unreachableAreas } : null,
    createdAt: 1,
    resolvedAt: null,
  }) as Notification

const projection = (over: Partial<InfraSetup> = {}): InfraSetup => ({
  ephemeralEnvironments: 'configured',
  agentExecutor: 'configured',
  binaryStorage: 'configured',
  ...over,
})

describe('recordedUnreachableAreas', () => {
  it('reads the recorded set off the open card', () => {
    expect(recordedUnreachableAreas(card(['agentExecutor']))).toEqual(['agentExecutor'])
  })

  it('is empty with no card, no payload, or an empty set', () => {
    expect(recordedUnreachableAreas(null)).toEqual([])
    expect(recordedUnreachableAreas(undefined)).toEqual([])
    expect(recordedUnreachableAreas(card())).toEqual([])
    expect(recordedUnreachableAreas(card([]))).toEqual([])
  })

  it('drops an area this build does not probe', () => {
    // A card written by a newer deployment (or a hand-edited payload) must not inject an area the
    // projection fold would then never be able to clear.
    expect(recordedUnreachableAreas(card(['agentExecutor', 'binaryStorage', 'wat']))).toEqual([
      'agentExecutor',
    ])
  })
})

describe('decideReachability', () => {
  const probe = (area: string, verdict: ProbeOutcome['verdict'], detail?: string): ProbeOutcome =>
    ({ area, verdict, ...(detail ? { detail } : {}) }) as ProbeOutcome

  it('announces a new outage and records it', () => {
    const decision = decideReachability([], [probe('agentExecutor', 'unreachable', 'ECONNREFUSED')])
    expect(decision.unreachableAreas).toEqual(['agentExecutor'])
    expect(decision.transitions).toEqual([
      { area: 'agentExecutor', status: 'unreachable', detail: 'ECONNREFUSED' },
    ])
  })

  it('announces nothing while an outage persists', () => {
    // The whole point of recording the set: a watcher polling on a sweep cadence must not
    // re-announce an ongoing outage on every pass.
    const decision = decideReachability(
      ['agentExecutor'],
      [probe('agentExecutor', 'unreachable', 'ECONNREFUSED')],
    )
    expect(decision.unreachableAreas).toEqual(['agentExecutor'])
    expect(decision.transitions).toEqual([])
  })

  it('announces a recovery and clears it from the recorded set', () => {
    const decision = decideReachability(['agentExecutor'], [probe('agentExecutor', 'reachable')])
    expect(decision.unreachableAreas).toEqual([])
    expect(decision.transitions).toEqual([{ area: 'agentExecutor', status: 'configured' }])
  })

  it('carries no detail on a recovery', () => {
    const decision = decideReachability(
      ['agentExecutor'],
      [probe('agentExecutor', 'reachable', 'all good')],
    )
    expect(decision.transitions[0]).not.toHaveProperty('detail')
  })

  it('leaves an indeterminate area exactly as recorded', () => {
    // An unresolvable connection / undecryptable secret is a LOCAL fault, so it must neither
    // invent an outage nor clear a real one.
    const healthy = decideReachability([], [probe('agentExecutor', 'indeterminate', 'no key')])
    expect(healthy).toEqual({ unreachableAreas: [], transitions: [], recordChanged: false })
    const failing = decideReachability(
      ['agentExecutor'],
      [probe('agentExecutor', 'indeterminate', 'no key')],
    )
    expect(failing).toEqual({
      unreachableAreas: ['agentExecutor'],
      transitions: [],
      recordChanged: false,
    })
  })

  it('forgets a recorded outage for an area that is no longer configured, silently', () => {
    // The fix for an outage card outliving its connection: an operator who un-registers a dead
    // runner pool must not keep the card forever (nothing else ever clears it), but "gone" is not a
    // recovery either — announcing `configured` would claim a connection that no longer exists is
    // healthy. So the record drops and NOTHING is published; the snapshot's `not_defined` setup gap
    // is the honest next state.
    const decision = decideReachability(
      ['agentExecutor'],
      [probe('agentExecutor', 'not_configured')],
    )
    expect(decision.unreachableAreas).toEqual([])
    expect(decision.transitions).toEqual([])
    expect(decision.recordChanged).toBe(true)
  })

  it('is a no-op for an unconfigured area that was never recorded', () => {
    const decision = decideReachability([], [probe('agentExecutor', 'not_configured')])
    expect(decision).toEqual({ unreachableAreas: [], transitions: [], recordChanged: false })
  })

  it('reports recordChanged whenever the set moves, and only then', () => {
    // The sweep gates its card write on this, so it must not be inferrable from `transitions`
    // alone — a `not_configured` drop changes the record while announcing nothing.
    expect(decideReachability([], [probe('agentExecutor', 'unreachable')]).recordChanged).toBe(true)
    expect(
      decideReachability(['agentExecutor'], [probe('agentExecutor', 'reachable')]).recordChanged,
    ).toBe(true)
    expect(
      decideReachability(['agentExecutor'], [probe('agentExecutor', 'unreachable')]).recordChanged,
    ).toBe(false)
    expect(decideReachability(['agentExecutor'], []).recordChanged).toBe(false)
  })

  it('keeps an area that was not probed this pass', () => {
    const decision = decideReachability(
      ['ephemeralEnvironments'],
      [probe('agentExecutor', 'reachable')],
    )
    expect(decision.unreachableAreas).toEqual(['ephemeralEnvironments'])
    expect(decision.transitions).toEqual([])
  })

  it('sorts the recorded set so probe order is not a content change', () => {
    const a = decideReachability(
      [],
      [probe('ephemeralEnvironments', 'unreachable'), probe('agentExecutor', 'unreachable')],
    )
    const b = decideReachability(
      [],
      [probe('agentExecutor', 'unreachable'), probe('ephemeralEnvironments', 'unreachable')],
    )
    expect(a.unreachableAreas).toEqual(b.unreachableAreas)
    expect(a.unreachableAreas).toEqual(['agentExecutor', 'ephemeralEnvironments'])
  })

  it('reports both directions in one pass', () => {
    const decision = decideReachability(
      ['agentExecutor'],
      [
        probe('agentExecutor', 'reachable'),
        probe('ephemeralEnvironments', 'unreachable', 'HTTP 502'),
      ],
    )
    expect(decision.unreachableAreas).toEqual(['ephemeralEnvironments'])
    expect(decision.transitions).toEqual([
      { area: 'agentExecutor', status: 'configured' },
      { area: 'ephemeralEnvironments', status: 'unreachable', detail: 'HTTP 502' },
    ])
  })
})

describe('applyInfraReachability', () => {
  it('downgrades a configured area to unreachable', () => {
    expect(applyInfraReachability(projection(), ['agentExecutor'])).toEqual(
      projection({ agentExecutor: 'unreachable' }),
    )
  })

  it('returns the projection untouched when nothing is recorded', () => {
    const input = projection()
    expect(applyInfraReachability(input, [])).toBe(input)
  })

  it('never overrides not_defined, not_applicable, or an already-unreachable area', () => {
    // The un-registered / not-needed states out-rank a stale probe: `not_defined` means the
    // connection is GONE, so the actionable nag is "set it up", not "your provider is down".
    const input = projection({
      agentExecutor: 'not_defined',
      ephemeralEnvironments: 'not_applicable',
    })
    expect(applyInfraReachability(input, ['agentExecutor', 'ephemeralEnvironments'])).toEqual(input)
  })
})
