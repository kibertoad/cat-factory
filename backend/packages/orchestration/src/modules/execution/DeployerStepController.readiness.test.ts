import { describe, expect, it } from 'vitest'
import type { Block, EnvironmentHandle, ExecutionInstance, PipelineStep } from '@cat-factory/kernel'
import { ENVIRONMENT_READY_TIMEOUT_MS } from '@cat-factory/kernel'
import {
  DeployerStepController,
  type DeployerStepControllerDeps,
} from './DeployerStepController.js'

// A provider whose `provision()` is asynchronous — which every real per-PR environment backend is
// — answers with the environment still `provisioning` and no URL. The deployer used to record the
// task's OWN frame `ready` at that answer anyway, and nothing ever re-read the provider, so the
// run handed its tester `URL: (pending)` beside an instruction to test that URL and the
// environment came online while the tester was already running.
//
// These pin the replacement: not-`ready` parks the step on a readiness wait, the wait settles on
// what the provider actually says, and a state the environment will never leave is refused
// immediately rather than waited out.

const FRAME = {
  id: 'frame-1',
  level: 'frame',
  title: 'Glossary API',
  type: 'service',
  provisioning: { type: 'custom', manifestId: 'kargo' },
} as unknown as Block

const START = 1_700_000_000_000

function step(): PipelineStep {
  return { agentKind: 'deployer' } as unknown as PipelineStep
}

function instance(): ExecutionInstance {
  return { id: 'exec-1', blockId: 'frame-1', currentStep: 0, steps: [{}, {}] } as ExecutionInstance
}

function handle(over: Partial<EnvironmentHandle> = {}): EnvironmentHandle {
  return {
    id: 'env-1',
    status: 'provisioning',
    url: null,
    lastError: null,
    ...over,
  } as EnvironmentHandle
}

/**
 * A controller whose provider answers `provision()` with `provisioned`, then answers each
 * readiness poll from `statuses` (the last entry repeats). `now` is advanced explicitly so a test
 * can cross the readiness ceiling without waiting through it.
 */
function controller(
  provisioned: EnvironmentHandle,
  statuses: EnvironmentHandle[] = [],
  /**
   * What the block's live environment reads back as, for the projection the parked step renders.
   * Defaults to nothing: most tests here assert the WAIT, and a projection is a separate claim.
   */
  projected?: () => EnvironmentHandle | undefined,
) {
  const calls = { provisioned: 0, refreshed: 0, recorded: [] as { output: string }[] }
  let now = START
  const deps = {
    blockRepository: { get: async () => FRAME, listByWorkspace: async () => [FRAME] },
    contextBuilder: { resolveServiceFrameId: async () => FRAME.id },
    clock: { now: () => now },
    runStateMachine: {
      casPersist: async () => undefined,
      persistAndEmit: async () => undefined,
      emitInstance: async () => undefined,
    },
    environmentProvisioning: {
      canProvision: async () => ({ ok: true }),
      hasLegacyConnection: async () => false,
      supersedeForBlock: async () => undefined,
      getHandleForBlock: async () => projected?.(),
      startProvision: async () => {
        calls.provisioned += 1
        return { kind: 'completed' as const, handle: provisioned, reason: null }
      },
      refreshStatus: async () => {
        const answer = statuses[Math.min(calls.refreshed, statuses.length - 1)] ?? provisioned
        calls.refreshed += 1
        return answer
      },
    },
    recordStepResult: async (
      _ws: string,
      _instance: ExecutionInstance,
      _step: PipelineStep,
      _isFinal: boolean,
      result: { output: string },
    ) => {
      calls.recorded.push(result)
      return { kind: 'done' as const }
    },
    applyContainerRunning: () => false,
    applySubtaskProgress: () => false,
    recoverContainerEviction: async () => null,
  } as unknown as DeployerStepControllerDeps
  return {
    controller: new DeployerStepController(deps),
    calls,
    advanceClock: (ms: number) => {
      now += ms
    },
  }
}

describe('DeployerStepController: environment readiness', () => {
  it('parks on a provisioning environment instead of recording the frame ready', async () => {
    const s = step()
    const { controller: c } = controller(handle())

    const result = await c.runDeployerStep('ws-1', instance(), s, FRAME, false)

    expect(result).toMatchObject({ kind: 'awaiting_environment', stepIndex: 0 })
    // Nothing terminal is written: the frame has no outcome yet, which is what keeps the fan-out
    // (and the disposer, and the tester's context) from reading a live environment that isn't one.
    expect(s.deployEnvs?.[FRAME.id]).toBeUndefined()
    expect(s.deployWait).toMatchObject({
      frameId: FRAME.id,
      environmentId: 'env-1',
      startedAt: START,
      polls: 0,
    })
  })

  it('re-parks on a live wait instead of provisioning the same frame twice', async () => {
    const s = step()
    const { controller: c, calls } = controller(handle())
    await c.runDeployerStep('ws-1', instance(), s, FRAME, false)
    expect(calls.provisioned).toBe(1)

    // A re-advance while the wait is still live: a durable replay, a Node worker restarting
    // mid-run, the stale-run sweeper re-driving. The waiting frame is deliberately ABSENT from
    // `deployEnvs` (which records terminal outcomes only), so without a re-attach guard the
    // fan-out picks it as the next un-settled frame and stands a SECOND environment up for it,
    // leaking the first with nothing left pointing at it for the disposer to reclaim.
    const again = await c.runDeployerStep('ws-1', instance(), s, FRAME, false)

    expect(again).toMatchObject({ kind: 'awaiting_environment', stepIndex: 0 })
    expect(calls.provisioned).toBe(1)
    // The wait is re-attached UNCHANGED: same environment, same deadline anchor, so a replay
    // cannot quietly restart the readiness ceiling and wait out a second full 20 minutes.
    expect(s.deployWait).toMatchObject({ environmentId: 'env-1', startedAt: START, polls: 0 })
  })

  it('keeps waiting while the provider still says provisioning, counting the polls', async () => {
    const s = step()
    const { controller: c, calls } = controller(handle())
    await c.runDeployerStep('ws-1', instance(), s, FRAME, false)

    const result = await c.pollDeployerEnvironment('ws-1', instance(), s)

    expect(result).toMatchObject({ kind: 'awaiting_environment' })
    expect(calls.refreshed).toBe(1)
    expect(s.deployWait?.polls).toBe(1)
    expect(s.deployEnvs?.[FRAME.id]).toBeUndefined()
  })

  it('records the frame ready with the URL the provider finally published', async () => {
    const s = step()
    const { controller: c, calls } = controller(handle(), [
      handle({ status: 'ready', url: 'https://pr-8.example.test' }),
    ])
    await c.runDeployerStep('ws-1', instance(), s, FRAME, false)

    await c.pollDeployerEnvironment('ws-1', instance(), s)

    expect(s.deployWait).toBeUndefined()
    expect(s.deployEnvs?.[FRAME.id]).toEqual({
      status: 'ready',
      url: 'https://pr-8.example.test',
      environmentId: 'env-1',
    })
    // The fan-out resumed and completed the step, so the run's summary names the real address
    // rather than "(pending)".
    expect(calls.recorded[0]?.output).toContain('https://pr-8.example.test')
  })

  it('fails the step once the readiness ceiling is spent, as a timeout', async () => {
    const s = step()
    const { controller: c, advanceClock } = controller(handle())
    await c.runDeployerStep('ws-1', instance(), s, FRAME, false)
    advanceClock(ENVIRONMENT_READY_TIMEOUT_MS)

    const result = await c.pollDeployerEnvironment('ws-1', instance(), s)

    expect(result).toMatchObject({
      kind: 'job_failed',
      failureKind: 'environment',
      reason: 'timeout',
    })
    expect(result).toMatchObject({ detail: expect.stringContaining('20 minutes') })
    expect(s.deployEnvs?.[FRAME.id]).toMatchObject({ status: 'failed', environmentId: 'env-1' })
    expect(s.deployWait).toBeUndefined()
  })

  it('names what the provider said it was waiting on when the ceiling is spent', async () => {
    // The gap issue #2153 filed: the ceiling formatted `lastError` into its message and
    // `lastError` is nulled on `provisioning`, so a 20-minute wait could only report that it had
    // waited 20 minutes. The note is the channel a provisioning provider actually has, and this
    // is where the run's failure detail picks it up.
    const s = step()
    const { controller: c, advanceClock } = controller(handle(), [
      handle({ statusNote: 'the deploy succeeded and no target went healthy' }),
    ])
    await c.runDeployerStep('ws-1', instance(), s, FRAME, false)
    advanceClock(ENVIRONMENT_READY_TIMEOUT_MS)

    const result = await c.pollDeployerEnvironment('ws-1', instance(), s)

    expect(result).toMatchObject({
      reason: 'timeout',
      detail: expect.stringContaining(
        'Last provider note: the deploy succeeded and no target went healthy',
      ),
    })
  })

  it('emits a projection when the note is the only thing that moved', async () => {
    // Every poll of a readiness wait leaves the id, the status and the (absent) URL identical, so
    // the note is the ONLY field that changes while an environment comes up. Left out of the
    // change comparison, the one update this projection exists to deliver is the one it never
    // pushes, and the panel sits on the first note for the whole wait.
    const s = step()
    let note = 'the deploy job is queued'
    const { controller: c } = controller(handle(), [], () => handle({ statusNote: note }))

    expect(await c.attachEnvironmentProjection('ws-1', 'frame-1', s)).toBe(true)
    expect(s.environment?.statusNote).toBe('the deploy job is queued')
    // The same answer twice is not a change: the projection stays off the emit path when the
    // provider is repeating itself.
    expect(await c.attachEnvironmentProjection('ws-1', 'frame-1', s)).toBe(false)

    note = 'the deploy job is running'
    expect(await c.attachEnvironmentProjection('ws-1', 'frame-1', s)).toBe(true)
    expect(s.environment?.statusNote).toBe('the deploy job is running')
  })

  it('emits a projection for any field it carries, not a listed subset', async () => {
    // The same argument as the note, for the fields beside it. A TTL a provider publishes only
    // once the environment is scheduled arrives mid-wait with the id, status and URL unchanged,
    // and a comparison that did not look at it projected the value and never pushed it: the
    // panel's "expires" line stayed absent for the rest of the run.
    const s = step()
    let expiresAt: number | null = null
    const { controller: c } = controller(handle(), [], () =>
      handle({ status: 'provisioning', url: null, expiresAt }),
    )

    expect(await c.attachEnvironmentProjection('ws-1', 'frame-1', s)).toBe(true)
    expect(s.environment?.expiresAt).toBeNull()

    expiresAt = START + 3_600_000
    expect(await c.attachEnvironmentProjection('ws-1', 'frame-1', s)).toBe(true)
    expect(s.environment?.expiresAt).toBe(expiresAt)
  })

  it('refuses a state the environment will never leave without waiting it out', async () => {
    const s = step()
    const { controller: c, calls } = controller(
      handle({ status: 'expired', lastError: 'TTL elapsed' }),
    )

    const result = await c.runDeployerStep('ws-1', instance(), s, FRAME, false)

    expect(result).toMatchObject({
      kind: 'job_failed',
      failureKind: 'environment',
      reason: 'environment_not_ready',
      detail: 'TTL elapsed',
    })
    // No wait was entered, so no poll was spent on an answer that could not change.
    expect(calls.refreshed).toBe(0)
    expect(s.deployWait).toBeUndefined()
  })
})
