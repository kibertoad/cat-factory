import { describe, expect, it } from 'vitest'
import type { Block, ExecutionInstance, PipelineStep, RunnerJobView } from '@cat-factory/kernel'
import {
  DeployerStepController,
  type DeployerStepControllerDeps,
} from './DeployerStepController.js'
import type { DeployFixFailure } from './DeployFixController.js'
import type {
  EnvironmentInvestigationFailure,
  EnvironmentInvestigationOutcome,
} from './EnvironmentInvestigationController.js'

// A provisioning failure reaches the remediation loop by TWO routes, and only one of them is a
// thrown error. A provider that refuses inline throws, and the dispatch path reads its class off
// `details.reason`. A provider that instead settles a `failed` environment (every container-backed
// deploy, and any provider treating a deterministic rejection as an ordinary outcome) throws
// nothing, so its classification rides beside the handle as `SettledProvision.reason`.
//
// That second route used to end at a handle, which carries only prose. The loop then read every
// non-throwing failure as unclassified and declined it, which is indistinguishable from a provider
// that never classified anything: the whole remediation feature was reachable only from the
// synchronous raw-manifest path, and nothing said so.

const FRAME = { id: 'blk-1', level: 'frame', title: 'Checkout', type: 'service' } as Block

const DONE = { state: 'done', result: {} } as RunnerJobView

function step(): PipelineStep {
  return {
    agentKind: 'deployer',
    jobId: 'deploy-1',
    deployProvisioning: { type: 'kubernetes' },
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

/**
 * A controller whose async finalize settles a FAILED environment carrying `reason`, with a
 * `deployFix` that records what it was offered and declines (so the caller's terminal path runs
 * either way and the assertion is about the hand-off, not about what the loop then does).
 */
function controller(reason: string | null, investigation?: EnvironmentInvestigationOutcome | null) {
  const offered: DeployFixFailure[] = []
  const investigated: EnvironmentInvestigationFailure[] = []
  const deps = {
    blockRepository: { get: async () => FRAME, listByWorkspace: async () => [FRAME] },
    contextBuilder: { resolveServiceFrameId: async () => FRAME.id },
    runStateMachine: { casPersist: async () => undefined, persistAndEmit: async () => undefined },
    environmentProvisioning: {
      pollProvisionJob: async () => DONE,
      releaseProvisionJob: async () => undefined,
      getHandleForBlock: async () => undefined,
      finalizeProvision: async () => ({
        handle: {
          id: 'env-1',
          status: 'failed',
          url: null,
          lastError: 'Deployment.apps "catalog-api" is invalid',
        },
        reason,
      }),
    },
    deployFix: {
      escalate: async (args: { failure: DeployFixFailure }) => {
        offered.push(args.failure)
        return null
      },
    },
    environmentInvestigation: {
      investigate: async (args: { failure: EnvironmentInvestigationFailure }) => {
        investigated.push(args.failure)
        return investigation ?? null
      },
    },
    recordStepResult: async () => ({ kind: 'noop' as const }),
    applyContainerRunning: () => false,
    applySubtaskProgress: () => false,
    recoverContainerEviction: async () => null,
  } as unknown as DeployerStepControllerDeps
  return { controller: new DeployerStepController(deps), offered, investigated }
}

describe('DeployerStepController: a failure the provider settled rather than threw', () => {
  it('offers the loop the class the provider stated, not an unclassified failure', async () => {
    const { controller: c, offered } = controller('manifest_invalid')
    await c.pollDeployerJob('ws-1', instance(), step())

    expect(offered).toHaveLength(1)
    expect(offered[0]).toMatchObject({
      frameId: FRAME.id,
      reason: 'manifest_invalid',
      error: expect.stringContaining('catalog-api'),
    })
  })

  it('leaves an unclassified failure unclassified rather than inventing a class for it', async () => {
    // The Kubernetes deploy container's own shape: free-form CLI output with no structured cause.
    // Absent must arrive as absent, because the loop's admission rule reads it directly and a
    // fabricated class here would be a fixer dispatched at a failure nobody understood.
    const { controller: c, offered } = controller(null)
    await c.pollDeployerJob('ws-1', instance(), step())

    expect(offered).toHaveLength(1)
    expect(offered[0]!.reason).toBeUndefined()
  })
})

describe('DeployerStepController: the investigation hand-off', () => {
  it('offers the failure the fixer declined to the investigation, with the environment named', async () => {
    // The two loops are mutually exclusive by construction: the fixer runs for the one cause a
    // checkout edit can fix, this for every other. Without the hand-off, everything outside that
    // one class ends the run with nobody able to say why.
    const c = controller(null)
    await c.controller.pollDeployerJob('ws-1', instance(), step())

    expect(c.offered).toHaveLength(1)
    expect(c.investigated).toHaveLength(1)
    expect(c.investigated[0]).toMatchObject({
      frameId: FRAME.id,
      frameTitle: FRAME.title,
      environmentId: 'env-1',
      error: expect.stringContaining('catalog-api'),
    })
  })

  it('records the investigation’s named cause in place of the bare provider error', async () => {
    // The second of the two outcomes the feature owes: still a stop, but a stop with a cause.
    const c = controller(null, { kind: 'reported', message: 'the VM went offline' })
    const result = await c.controller.pollDeployerJob('ws-1', instance(), step())
    expect(result).toMatchObject({ kind: 'job_failed', detail: 'the VM went offline' })
  })

  it('returns the loop’s advance when it acted, instead of failing the step', async () => {
    const c = controller(null, { kind: 'retrying', advance: { kind: 'continue' } })
    expect(await c.controller.pollDeployerJob('ws-1', instance(), step())).toEqual({
      kind: 'continue',
    })
  })
})
