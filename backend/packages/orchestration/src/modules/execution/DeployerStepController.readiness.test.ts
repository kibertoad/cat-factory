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
function controller(provisioned: EnvironmentHandle, statuses: EnvironmentHandle[] = []) {
  const calls = { refreshed: 0, recorded: [] as { output: string }[] }
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
      getHandleForBlock: async () => undefined,
      startProvision: async () => ({
        kind: 'completed' as const,
        handle: provisioned,
        reason: null,
      }),
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
