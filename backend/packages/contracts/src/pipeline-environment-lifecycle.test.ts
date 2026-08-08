import { describe, expect, it } from 'vitest'
import {
  ENV_CONSUMER_AGENT_KINDS,
  pipelineEnvironmentProblems,
} from './pipeline-environment-lifecycle.js'

/** The reasons a step list produced, in step order: the shape every assertion below reads. */
const reasons = (agentKinds: string[], enabled?: boolean[]) =>
  pipelineEnvironmentProblems(agentKinds, enabled).map((p) => p.reason)

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
})
