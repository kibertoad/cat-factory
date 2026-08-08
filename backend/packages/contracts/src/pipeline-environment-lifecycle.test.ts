import { describe, expect, it } from 'vitest'
import {
  ENV_CONSUMER_AGENT_KINDS,
  pipelineEnvironmentProblems,
} from './pipeline-environment-lifecycle.js'

/** The reasons a step list produced, in step order: the shape every assertion below reads. */
const reasons = (
  agentKinds: string[],
  enabled?: boolean[],
  stepOptions?: ({ retainEnvironment?: boolean } | null)[],
) => pipelineEnvironmentProblems(agentKinds, enabled, stepOptions).map((p) => p.reason)

/** `stepOptions` marking exactly the named indices as declaring a retained environment. */
const retainedAt = (length: number, ...indices: number[]) =>
  Array.from({ length }, (_, i) => (indices.includes(i) ? { retainEnvironment: true } : null))

describe('pipelineEnvironmentProblems', () => {
  it('accepts a chain that provisions, consumes and reclaims in that order', () => {
    expect(reasons(['coder', 'deployer', 'tester-api', 'merger', 'disposer'])).toEqual([])
  })

  it('reports a step with nothing to run against for EVERY kind that consumes an environment', () => {
    // Derived from the exported set rather than a hand-listed copy: a kind added to the
    // vocabulary must be covered by this rule, and a test naming its own four would not notice.
    for (const consumer of ENV_CONSUMER_AGENT_KINDS) {
      expect(reasons(['coder', consumer]), consumer).toEqual(['consumer_without_deployer'])
    }
  })

  it('reports a deployer nothing reclaims, and a disposer with nothing to reclaim', () => {
    expect(reasons(['coder', 'deployer', 'tester-api'])).toEqual(['deployer_without_disposer'])
    expect(reasons(['coder', 'disposer'])).toEqual(['disposer_without_deployer'])
  })

  it('reads ORDER, not mere presence: a disposer before the deployer reclaims nothing', () => {
    // Both faults are real here and both are reported: the disposer runs before anything is
    // provisioned, and the deployer that follows it is never reclaimed.
    expect(reasons(['disposer', 'deployer', 'tester-api'])).toEqual([
      'disposer_without_deployer',
      'deployer_without_disposer',
    ])
  })

  it('reports every fault at once, so a draft is not fixed one rejected save at a time', () => {
    expect(reasons(['tester-api', 'deployer', 'human-test'])).toEqual([
      'consumer_without_deployer',
      'deployer_without_disposer',
    ])
  })

  it('reasons over the ENABLED subset, which is the chain a run is built from', () => {
    // A disabled deployer provisions nothing, so the tester after it is unserved: the exact
    // shape a half-edited draft reaches.
    expect(reasons(['deployer', 'tester-api', 'disposer'], [false, true, true])).toEqual([
      'consumer_without_deployer',
      'disposer_without_deployer',
    ])
    // A disabled disposer reclaims nothing, so the deployer is left standing.
    expect(reasons(['deployer', 'tester-api', 'disposer'], [true, true, false])).toEqual([
      'deployer_without_disposer',
    ])
    // A disabled CONSUMER needs nothing, so it imposes no requirement of its own.
    expect(reasons(['tester-api'], [false])).toEqual([])
  })

  it('says nothing about a chain that touches no environment at all', () => {
    expect(reasons(['coder', 'reviewer', 'conflicts', 'ci', 'merger'])).toEqual([])
  })

  it('anchors each fault on the step that carries it', () => {
    expect(pipelineEnvironmentProblems(['coder', 'deployer', 'tester-api'])).toEqual([
      { reason: 'deployer_without_disposer', index: 1, agentKind: 'deployer' },
    ])
  })

  it('reads order in BOTH directions: a consumer after the disposer runs against nothing', () => {
    // The environment is provisioned and reclaimed before the tester is reached, so the tester
    // dead-ends exactly as an unprovisioned one does. Reported as its own reason because the fix
    // is the opposite one: move the Disposer down, not add a Deployer.
    expect(reasons(['coder', 'deployer', 'disposer', 'tester-api'])).toEqual([
      'consumer_after_disposer',
    ])
    for (const consumer of ENV_CONSUMER_AGENT_KINDS) {
      expect(reasons(['deployer', 'disposer', consumer]), consumer).toEqual([
        'consumer_after_disposer',
      ])
    }
  })

  it('accepts a chain that provisions a SECOND time for a later consumer', () => {
    // Two complete lifecycles back to back. A presence-only check reads this as a mess of
    // contradictions; the state machine reads it as what it is.
    expect(
      reasons(['deployer', 'tester-api', 'disposer', 'deployer', 'human-test', 'disposer']),
    ).toEqual([])
  })

  it('reports a second disposer with nothing left standing to reclaim', () => {
    expect(reasons(['deployer', 'tester-api', 'disposer', 'disposer'])).toEqual([
      'disposer_without_deployer',
    ])
  })

  it('accepts a deployer that DECLARES its environment outlives the run', () => {
    const chain = ['coder', 'deployer', 'tester-api']
    expect(reasons(chain)).toEqual(['deployer_without_disposer'])
    expect(reasons(chain, undefined, retainedAt(chain.length, 1))).toEqual([])
  })

  it('refuses a retain declaration the chain contradicts', () => {
    // The disposer reclaims by the ids this deployer recorded, so the environment goes away
    // regardless of the tick. Saying so beats letting the author believe the opposite.
    const chain = ['deployer', 'tester-api', 'disposer']
    expect(reasons(chain, undefined, retainedAt(chain.length, 1))).toEqual([])
    expect(reasons(chain, undefined, retainedAt(chain.length, 0))).toEqual([
      'retained_deployer_reclaimed',
    ])
    // A DISABLED disposer reclaims nothing, so it contradicts nothing.
    expect(reasons(chain, [true, true, false], retainedAt(chain.length, 0))).toEqual([])
  })

  it('scopes a retain declaration to the deployer that carries it', () => {
    // The first environment is deliberately left up; the second says nothing, so it still owes a
    // reclaim, and the fault is anchored on the deployer that owes it rather than on the chain.
    expect(
      pipelineEnvironmentProblems(
        ['deployer', 'human-test', 'deployer', 'tester-api'],
        undefined,
        retainedAt(4, 0),
      ),
    ).toEqual([{ reason: 'deployer_without_disposer', index: 2, agentKind: 'deployer' }])
  })

  it('ignores a retain declaration on a kind that provisions nothing', () => {
    // Same rule as every other `stepOptions` field: it belongs to one kind and is inert on the
    // rest, so a stray tick can never talk a chain out of the reclaim its deployer owes.
    expect(reasons(['deployer', 'tester-api'], undefined, retainedAt(2, 1))).toEqual([
      'deployer_without_disposer',
    ])
  })
})
