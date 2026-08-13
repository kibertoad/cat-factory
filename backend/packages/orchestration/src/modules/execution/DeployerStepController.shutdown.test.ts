import { describe, expect, it } from 'vitest'
import type { Block, ExecutionInstance, PipelineStep, RunnerJobView } from '@cat-factory/kernel'
import {
  DeployerStepController,
  type DeployerStepControllerDeps,
} from './DeployerStepController.js'

// A deploy container's harness can be shut down under it exactly as an agent container's can: the
// deploy harness runs the same SIGTERM-then-exit-0 handler, on the same transports, and a drained
// or `docker stop`ped one exits 0 with the deploy job still in flight.
//
// The deployer poll used to read only the eviction verdict, which a shutdown deliberately does not
// carry, so the failure fell through to the ordinary provider path: no retry (what it lost when the
// transports learned the distinction) and no naming of the cause either, sending an operator to
// their provisioning config for a container that something outside it stopped.

const FRAME = { id: 'blk-1', level: 'frame', title: 'Checkout', type: 'service' } as Block

function step(): PipelineStep {
  return {
    agentKind: 'deployer',
    jobId: 'deploy-1',
    // Pinned at dispatch, so the poll does not re-resolve the frame's provisioning.
    deployProvisioning: { kind: 'container' },
  } as unknown as PipelineStep
}

function instance(): ExecutionInstance {
  return {
    id: 'exec-1',
    blockId: 'blk-1',
    currentStep: 0,
    steps: [{}, {}],
  } as ExecutionInstance
}

const SHUTDOWN = {
  state: 'failed',
  error: 'The executor-harness shut down while this job was still running',
  harnessShutdown: true,
  detail: 'Container abc exited while the job was running. Exit: exit code 0',
} as RunnerJobView

function controller(view: RunnerJobView) {
  const calls = { recovered: 0, released: [] as string[], finalized: 0 }
  const deps = {
    blockRepository: {
      get: async () => FRAME,
      listByWorkspace: async () => [FRAME],
    },
    contextBuilder: { resolveServiceFrameId: async () => FRAME.id },
    runStateMachine: {
      casPersist: async () => undefined,
      persistAndEmit: async () => undefined,
    },
    environmentProvisioning: {
      pollProvisionJob: async () => view,
      releaseProvisionJob: async () => undefined,
      getHandleForBlock: async () => undefined,
      finalizeProvision: async () => {
        calls.finalized += 1
        return { id: 'env-1', status: 'failed', lastError: 'provider said no' }
      },
    },
    recordStepResult: async () => ({ kind: 'noop' as const }),
    applyContainerRunning: () => false,
    applySubtaskProgress: () => false,
    recoverContainerEviction: async (
      _workspaceId: string,
      _instance: ExecutionInstance,
      _step: PipelineStep,
      failure: { evicted?: string },
    ) => {
      calls.recovered += 1
      // Mirrors the real recovery's first line, so "consulted" and "spent a budget" stay distinct.
      return failure.evicted ? { kind: 'continue' as const } : null
    },
  } as unknown as DeployerStepControllerDeps
  return { controller: new DeployerStepController(deps), calls }
}

describe('DeployerStepController: a deploy harness shutdown', () => {
  it('fails the step under its own kind rather than as a broken environment', async () => {
    const { controller: c, calls } = controller(SHUTDOWN)
    const result = await c.pollDeployerJob('ws-1', instance(), step())

    expect(result).toMatchObject({ kind: 'job_failed', failureKind: 'harness_shutdown' })
    // Both halves of the account: what happened, and the transport's post-mortem of how, which is
    // the only evidence that outlives the reclaimed container.
    expect(result).toMatchObject({ detail: expect.stringContaining('shut down') })
    expect(result).toMatchObject({ detail: expect.stringContaining('exit code 0') })
    // The provider never sees the view, so it cannot map a stopped container to a failed env and
    // hand the operator a provisioning problem that isn't one.
    expect(calls.finalized).toBe(0)
  })

  it('spends no restart budget, because the view it carries names no eviction', async () => {
    const s = step()
    const { controller: c, calls } = controller(SHUTDOWN)
    await c.pollDeployerJob('ws-1', instance(), s)

    expect(calls.recovered).toBe(1)
    expect(s.evictionRecoveries).toBeUndefined()
  })

  it('still finalizes an ordinary failed deploy through the provider', async () => {
    // The unchanged path, pinned beside it: a deploy that genuinely failed is the provider's
    // verdict to give, and it keeps the `environment` failure kind.
    const failed = { state: 'failed', error: 'kustomize build failed' } as RunnerJobView
    const { controller: c, calls } = controller(failed)
    const result = await c.pollDeployerJob('ws-1', instance(), step())

    expect(calls.finalized).toBe(1)
    expect(result).toMatchObject({ kind: 'job_failed', failureKind: 'environment' })
  })
})
