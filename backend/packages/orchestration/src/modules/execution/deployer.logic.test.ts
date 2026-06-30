import { describe, expect, it } from 'vitest'
import { DEPLOYER_AGENT_KIND } from '@cat-factory/integrations'
import type { PipelineStep } from '@cat-factory/kernel'
import { deployEvictionEpoch, deployJobId } from './deployer.logic.js'

const step = (over: Partial<PipelineStep> = {}): PipelineStep =>
  ({ agentKind: DEPLOYER_AGENT_KIND, ...over }) as PipelineStep

describe('deployJobId', () => {
  it('is deterministic from the run id (replay-stable, no epoch suffix at epoch 0)', () => {
    expect(deployJobId('exec1', 0)).toBe(`exec1-${DEPLOYER_AGENT_KIND}`)
    // Same inputs reproduce the same id, so a replayed dispatch re-attaches rather than
    // starting a duplicate deploy container.
    expect(deployJobId('exec1', 0)).toBe(deployJobId('exec1', 0))
  })

  it('suffixes the eviction epoch so each re-dispatch is a distinct job', () => {
    expect(deployJobId('exec1', 1)).toBe(`exec1-${DEPLOYER_AGENT_KIND}-1`)
    expect(deployJobId('exec1', 2)).toBe(`exec1-${DEPLOYER_AGENT_KIND}-2`)
    expect(deployJobId('exec1', 1)).not.toBe(deployJobId('exec1', 0))
  })

  it('scopes the id to the run', () => {
    expect(deployJobId('execA', 0)).not.toBe(deployJobId('execB', 0))
  })
})

describe('deployEvictionEpoch', () => {
  it('is 0 for a first dispatch', () => {
    expect(deployEvictionEpoch(step())).toBe(0)
  })

  it('sums genuine + transient eviction recoveries', () => {
    expect(deployEvictionEpoch(step({ evictionRecoveries: 2 }))).toBe(2)
    expect(deployEvictionEpoch(step({ transientEvictionRecoveries: 3 }))).toBe(3)
    expect(
      deployEvictionEpoch(step({ evictionRecoveries: 1, transientEvictionRecoveries: 4 })),
    ).toBe(5)
  })
})
