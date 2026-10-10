import { describe, expect, it } from 'vitest'
import { DEPLOYER_AGENT_KIND } from '@cat-factory/integrations'
import type { PipelineStep, ServiceProvisioning } from '@cat-factory/kernel'
import {
  appendAttemptLog,
  decideDeployerConfig,
  deployerServiceConfigIssues,
  deployDispatchEpoch,
  deployJobId,
  hasEnabledDeployerStep,
  orderProvisionTargets,
} from './deployer.logic.js'

const step = (over: Partial<PipelineStep> = {}): PipelineStep =>
  ({ agentKind: DEPLOYER_AGENT_KIND, ...over }) as PipelineStep

describe('deployJobId', () => {
  it('is deterministic from the run id (replay-stable, no epoch suffix at epoch 0)', () => {
    expect(deployJobId('exec1', 0)).toBe(`exec1-${DEPLOYER_AGENT_KIND}`)
  })

  it('suffixes the eviction epoch so each re-dispatch is a distinct job', () => {
    expect(deployJobId('exec1', 1)).toBe(`exec1-${DEPLOYER_AGENT_KIND}-1`)
    expect(deployJobId('exec1', 2)).toBe(`exec1-${DEPLOYER_AGENT_KIND}-2`)
    expect(deployJobId('exec1', 1)).not.toBe(deployJobId('exec1', 0))
  })

  it('scopes the id to the run', () => {
    expect(deployJobId('execA', 0)).not.toBe(deployJobId('execB', 0))
  })

  it('discriminates fanned-out per-frame jobs by frame id', () => {
    expect(deployJobId('exec1', 0, 'frameA')).toBe(`exec1-${DEPLOYER_AGENT_KIND}-frameA`)
    expect(deployJobId('exec1', 0, 'frameA')).not.toBe(deployJobId('exec1', 0, 'frameB'))
    // Frame + epoch stay distinct.
    expect(deployJobId('exec1', 2, 'frameA')).toBe(`exec1-${DEPLOYER_AGENT_KIND}-frameA-2`)
  })
})

describe('orderProvisionTargets', () => {
  const targets = (...ids: [string, boolean][]) =>
    ids.map(([frameId, isPrimary]) => ({ frameId, isPrimary }))
  const providers = (m: Record<string, string[]>): Map<string, Set<string>> =>
    new Map(Object.entries(m).map(([k, v]) => [k, new Set(v)]))

  it('emits providers before the consumers that use them', () => {
    // own (consumer) uses provider `db`; `db` must provision first so own can receive its URL.
    const order = orderProvisionTargets(
      targets(['own', true], ['db', false]),
      providers({ own: ['db'], db: [] }),
    )
    expect(order).toEqual(['db', 'own'])
  })

  it('breaks ties primary-first then by ascending frame id', () => {
    const order = orderProvisionTargets(
      targets(['own', true], ['b', false], ['a', false]),
      providers({ own: [], a: [], b: [] }),
    )
    expect(order).toEqual(['own', 'a', 'b'])
  })

  it('is deterministic and total on a connection cycle (a↔b)', () => {
    const order = orderProvisionTargets(
      targets(['own', true], ['a', false], ['b', false]),
      providers({ own: ['a'], a: ['b'], b: ['a'] }),
    )
    // Every frame appears exactly once (cycle is broken, not deadlocked).
    expect([...order].sort()).toEqual(['a', 'b', 'own'])
    expect(new Set(order).size).toBe(3)
  })

  it('handles a lone primary target', () => {
    expect(orderProvisionTargets(targets(['own', true]), providers({ own: [] }))).toEqual(['own'])
  })
})

describe('deployDispatchEpoch', () => {
  it('is 0 for a first dispatch, stamped or not', () => {
    expect(deployDispatchEpoch(step())).toBe(0)
    expect(deployDispatchEpoch(step({ attempts: 1 }))).toBe(0)
  })

  it('sums genuine + transient eviction recoveries', () => {
    expect(deployDispatchEpoch(step({ evictionRecoveries: 2 }))).toBe(2)
    expect(deployDispatchEpoch(step({ transientEvictionRecoveries: 3 }))).toBe(3)
    expect(
      deployDispatchEpoch(step({ evictionRecoveries: 1, transientEvictionRecoveries: 4 })),
    ).toBe(5)
  })

  it('counts the step RE-STARTS too, so a rebuild loop-back cannot re-attach', () => {
    // The human-test gate's "rebuild the environment" resets the deployer and starts it again
    // (`rerunRange`), which bumps only `attempts`. Without this term the rebuild re-derived the
    // FIRST deploy's job id and the idempotent transport re-attached to its completed provision
    // job: nothing was re-provisioned, and the gate read back a stale environment as a fresh one.
    expect(deployDispatchEpoch(step({ attempts: 2 }))).toBe(1)
    expect(deployDispatchEpoch(step({ attempts: 3 }))).toBe(2)
    // Both terms in play: two rebuilds, one of which was also evicted and recovered.
    expect(deployDispatchEpoch(step({ attempts: 3, evictionRecoveries: 1 }))).toBe(3)
  })
})

describe('hasEnabledDeployerStep', () => {
  it('is true when an enabled deployer is present', () => {
    expect(hasEnabledDeployerStep(['coder', DEPLOYER_AGENT_KIND, 'tester'], undefined)).toBe(true)
  })

  it('treats a disabled deployer as absent', () => {
    expect(hasEnabledDeployerStep(['coder', DEPLOYER_AGENT_KIND], [true, false])).toBe(false)
  })

  it('is false with no deployer in the chain', () => {
    expect(hasEnabledDeployerStep(['coder', 'tester'], undefined)).toBe(false)
  })
})

describe('deployerServiceConfigIssues', () => {
  const provisioning = (over: Partial<ServiceProvisioning>): ServiceProvisioning =>
    ({ type: 'infraless', ...over }) as ServiceProvisioning

  it('is complete for infraless / undeclared (deployer no-op)', () => {
    expect(deployerServiceConfigIssues(undefined)).toEqual([])
    expect(deployerServiceConfigIssues(provisioning({ type: 'infraless' }))).toEqual([])
  })

  it('requires a manifest source for kubernetes', () => {
    expect(deployerServiceConfigIssues(provisioning({ type: 'kubernetes' }))).toEqual([
      'manifestSource',
    ])
    expect(
      deployerServiceConfigIssues(
        provisioning({
          type: 'kubernetes',
          manifestSource: { type: 'colocated', path: 'k8s' },
        }),
      ),
    ).toEqual([])
  })

  it('requires a compose path or recipe compose files for docker-compose', () => {
    expect(deployerServiceConfigIssues(provisioning({ type: 'docker-compose' }))).toEqual([
      'composePath',
    ])
    expect(
      deployerServiceConfigIssues(provisioning({ type: 'docker-compose', composePath: '  ' })),
    ).toEqual(['composePath'])
    expect(
      deployerServiceConfigIssues(
        provisioning({ type: 'docker-compose', composePath: 'docker-compose.yml' }),
      ),
    ).toEqual([])
    expect(
      deployerServiceConfigIssues(
        provisioning({ type: 'docker-compose', recipe: { composeFiles: ['compose.yaml'] } }),
      ),
    ).toEqual([])
  })

  it('requires a manifest id for custom', () => {
    expect(deployerServiceConfigIssues(provisioning({ type: 'custom' }))).toEqual(['manifestId'])
    expect(
      deployerServiceConfigIssues(provisioning({ type: 'custom', manifestId: 'preview' })),
    ).toEqual([])
  })
})

describe('decideDeployerConfig', () => {
  const ok = { ok: true } as const

  it('passes through for infraless / undeclared', () => {
    expect(
      decideDeployerConfig({ provisionType: undefined, serviceIssues: [], handlerResolution: ok }),
    ).toEqual(ok)
    expect(
      decideDeployerConfig({
        provisionType: 'infraless',
        serviceIssues: [],
        handlerResolution: ok,
      }),
    ).toEqual(ok)
  })

  it('reports an incomplete service config first (before the handler)', () => {
    expect(
      decideDeployerConfig({
        provisionType: 'kubernetes',
        serviceIssues: ['manifestSource'],
        // Even a missing handler is not surfaced while the service config is incomplete.
        handlerResolution: { ok: false, reason: 'no-handler' },
      }),
    ).toEqual({ ok: false, reason: 'service-config-incomplete', missing: ['manifestSource'] })
  })

  it('reports a missing / ambiguous workspace handler once the service config is sound', () => {
    expect(
      decideDeployerConfig({
        provisionType: 'kubernetes',
        serviceIssues: [],
        handlerResolution: { ok: false, reason: 'no-handler' },
      }),
    ).toEqual({ ok: false, reason: 'workspace-unhandled', handlerReason: 'no-handler' })
    expect(
      decideDeployerConfig({
        provisionType: 'custom',
        serviceIssues: [],
        handlerResolution: { ok: false, reason: 'type-mismatch' },
      }),
    ).toEqual({ ok: false, reason: 'workspace-unhandled', handlerReason: 'type-mismatch' })
  })

  it('reports a failing connection only after both structural checks pass', () => {
    expect(
      decideDeployerConfig({
        provisionType: 'kubernetes',
        serviceIssues: [],
        handlerResolution: ok,
        connectionTest: { ok: false, message: 'apiserver unreachable' },
      }),
    ).toEqual({ ok: false, reason: 'connection-failed', message: 'apiserver unreachable' })
  })

  it('passes when everything resolves and the connection probe is green (or absent)', () => {
    expect(
      decideDeployerConfig({
        provisionType: 'kubernetes',
        serviceIssues: [],
        handlerResolution: ok,
        connectionTest: { ok: true },
      }),
    ).toEqual(ok)
    expect(
      decideDeployerConfig({
        provisionType: 'kubernetes',
        serviceIssues: [],
        handlerResolution: ok,
      }),
    ).toEqual(ok)
  })
})

describe('appendAttemptLog', () => {
  const round = (attempt: number) => ({ attempt })

  it('keeps every round while the log is within its cap', () => {
    const first = appendAttemptLog(undefined, round(1), 3, undefined)
    const second = appendAttemptLog(first.attemptLog, round(2), 3, first.droppedAttempts)

    expect(second).toEqual({ attemptLog: [round(1), round(2)], droppedAttempts: 0 })
  })

  it('drops the OLDEST round past the cap and counts what went', () => {
    // The logs survive the whole run inside the compare-and-swapped run blob, so an uncapped one
    // grows with every loop-back. The drop is counted because the verification report reduces the
    // surviving rows: a silently dropped round reads as one that never ran.
    let state = { attemptLog: [round(1), round(2)] as { attempt: number }[], droppedAttempts: 0 }
    state = appendAttemptLog(state.attemptLog, round(3), 2, state.droppedAttempts)
    expect(state).toEqual({ attemptLog: [round(2), round(3)], droppedAttempts: 1 })

    state = appendAttemptLog(state.attemptLog, round(4), 2, state.droppedAttempts)
    expect(state).toEqual({ attemptLog: [round(3), round(4)], droppedAttempts: 2 })
  })
})
