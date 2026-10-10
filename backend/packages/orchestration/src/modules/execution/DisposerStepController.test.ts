import { describe, expect, it, vi } from 'vitest'
import type { AgentRunResult, Block, ExecutionInstance, PipelineStep } from '@cat-factory/kernel'
import { NotFoundError } from '@cat-factory/kernel'
import type { EnvironmentTeardownService } from '@cat-factory/integrations'
import { DisposerStepController } from './DisposerStepController.js'
import type { RunStateMachine } from './RunStateMachine.js'
import type { AdvanceResult } from './advance.js'

// The `disposer` step. Two properties carry the whole design and neither is visible from the
// teardown service's own tests: it reclaims exactly the environments THIS RUN stood up (read off
// the deployer's recorded outcomes, never re-derived), and it NEVER fails the run — a disposer
// usually runs after `merger`, so a teardown hiccup must not flip a shipped pipeline to failed.

const BLOCK = { id: 'task_login', title: 'Login', type: 'task' } as unknown as Block

function step(overrides: Partial<PipelineStep> & { agentKind: string }): PipelineStep {
  return overrides as unknown as PipelineStep
}

/** A run with a deployer that stood up whichever frames the test names. */
function instanceWith(steps: PipelineStep[]): ExecutionInstance {
  return { id: 'exec_1', blockId: 'task_login', currentStep: 1, steps } as ExecutionInstance
}

const deployed = step({
  agentKind: 'deployer',
  deployEnvs: {
    frm_api: { status: 'ready', url: 'https://api.test', environmentId: 'env_api' },
    frm_web: { status: 'skipped' },
    frm_old: { status: 'failed', error: 'quota exceeded' },
  },
})

interface Harness {
  controller: DisposerStepController
  results: AgentRunResult[]
  teardowns: string[]
}

/**
 * `teardown` is loosely typed on purpose: these tests only care about the confirmation the
 * controller reads off the result, and spelling out a whole `EnvironmentHandle` per case would
 * bury that behind fixture noise. Null ⇒ the environment integration is unwired.
 *
 * There is deliberately no provisioning-service fake to configure: the controller resolves
 * nothing, because the environment id it tears down by is the one the DEPLOYER recorded.
 */
function harness(teardown: { teardown: (...args: never[]) => Promise<unknown> } | null): Harness {
  const results: AgentRunResult[] = []
  const teardowns: string[] = []
  const wrapped = teardown
    ? ({
        teardown: async (ws: string, id: string) => {
          teardowns.push(id)
          return (teardown.teardown as unknown as (w: string, i: string) => Promise<unknown>)(
            ws,
            id,
          )
        },
      } as unknown as EnvironmentTeardownService)
    : undefined
  const controller = new DisposerStepController({
    runStateMachine: { casPersist: async () => {} } as unknown as RunStateMachine,
    environmentTeardown: wrapped,
    recordStepResult: async (_ws, _i, _s, _f, result): Promise<AdvanceResult> => {
      results.push(result)
      return { kind: 'noop' }
    },
  })
  return { controller, results, teardowns }
}

describe('DisposerStepController', () => {
  it('reclaims only the frames the run actually provisioned', async () => {
    // `skipped` frames were never meant to have an environment and `failed` ones never got one,
    // so neither is something to reclaim — and listing them would pad the summary with frames the
    // disposer did no work for.
    const { controller, teardowns } = harness({
      teardown: async () => ({ confirmation: 'confirmed', reason: null, handle: {} }),
    })
    const disposer = step({ agentKind: 'disposer' })

    await controller.runDisposerStep(
      'ws_1',
      instanceWith([deployed, disposer]),
      disposer,
      BLOCK,
      true,
    )

    expect(teardowns).toEqual(['env_api'])
    expect(Object.keys(disposer.disposeEnvs ?? {})).toEqual(['frm_api'])
  })

  it('records a CONFIRMED reclaim as such', async () => {
    const { controller, results } = harness({
      teardown: async () => ({ confirmation: 'confirmed', reason: null, handle: {} }),
    })
    const disposer = step({ agentKind: 'disposer' })

    await controller.runDisposerStep(
      'ws_1',
      instanceWith([deployed, disposer]),
      disposer,
      BLOCK,
      true,
    )

    expect(disposer.disposeEnvs?.frm_api).toMatchObject({
      status: 'reclaimed',
      environmentId: 'env_api',
      confirmation: 'confirmed',
    })
    expect(results[0]?.output).toContain('confirmed gone')
  })

  it('does not report an UNCONFIRMED teardown as a clean reclaim', async () => {
    // The provider accepted the destroy and the probe found the environment still running. The
    // step still succeeds, but its output must say so rather than reading like a tidy reclaim.
    const { controller, results } = harness({
      teardown: async () => ({
        confirmation: 'still_standing',
        reason: 'The environment was still running after the teardown.',
        handle: {},
      }),
    })
    const disposer = step({ agentKind: 'disposer' })

    await controller.runDisposerStep(
      'ws_1',
      instanceWith([deployed, disposer]),
      disposer,
      BLOCK,
      true,
    )

    expect(disposer.disposeEnvs?.frm_api).toMatchObject({ confirmation: 'still_standing' })
    expect(results[0]?.output).toContain('could not confirm it is gone')
    expect(results[0]?.output).toContain('still running after the teardown')
  })

  it('never fails the run when a provider refuses the teardown', async () => {
    // A disposer usually runs after `merger`: the work shipped and the PR is in, so an
    // un-reclaimed environment is a recorded warning and an operator's job, never a failed run.
    const { controller, results } = harness({
      teardown: async () => {
        throw new Error('provider refused: environment is locked')
      },
    })
    const disposer = step({ agentKind: 'disposer' })

    const advance = await controller.runDisposerStep(
      'ws_1',
      instanceWith([deployed, disposer]),
      disposer,
      BLOCK,
      true,
    )

    expect(advance).toEqual({ kind: 'noop' })
    expect(disposer.disposeEnvs?.frm_api).toMatchObject({
      status: 'failed',
      error: expect.stringContaining('provider refused'),
    })
    expect(results[0]?.output).toContain('TTL sweep remains the backstop')
  })

  it('says there was nothing to reclaim when the run provisioned nothing', async () => {
    const { controller, results, teardowns } = harness({ teardown: async () => ({}) })
    const disposer = step({ agentKind: 'disposer' })

    await controller.runDisposerStep(
      'ws_1',
      instanceWith([step({ agentKind: 'coder' }), disposer]),
      disposer,
      BLOCK,
      true,
    )

    expect(teardowns).toEqual([])
    expect(results[0]?.output).toContain('nothing to reclaim')
  })

  it('claims no credit for an environment something else already took', async () => {
    // A supersede, an operator's Destroy or the TTL sweep on a long run can get there first. The
    // registry read behind `teardown` skips tombstones, so it answers with a NotFoundError. That
    // is a legitimate outcome, but this step did not observe the environment going away, so it
    // records `none` rather than a reclaim it cannot vouch for.
    const { controller } = harness({
      teardown: async () => {
        throw new NotFoundError('Environment', 'env_api')
      },
    })
    const disposer = step({ agentKind: 'disposer' })

    await controller.runDisposerStep(
      'ws_1',
      instanceWith([deployed, disposer]),
      disposer,
      BLOCK,
      true,
    )

    expect(disposer.disposeEnvs?.frm_api).toEqual({ status: 'none', environmentId: 'env_api' })
  })

  it('does not read a registry OUTAGE as an environment that is already gone', async () => {
    // The failure directly above and this one arrive at the same call site, and only the error
    // TYPE tells them apart. Swallowing both would report "nothing to reclaim" about a live
    // environment whenever the store hiccups — the same false-clean reading the confirmation
    // probe exists to stop, one layer up.
    const { controller } = harness({
      teardown: async () => {
        throw new Error('connection terminated unexpectedly')
      },
    })
    const disposer = step({ agentKind: 'disposer' })

    await controller.runDisposerStep(
      'ws_1',
      instanceWith([deployed, disposer]),
      disposer,
      BLOCK,
      true,
    )

    expect(disposer.disposeEnvs?.frm_api).toMatchObject({
      status: 'failed',
      error: expect.stringContaining('connection terminated'),
    })
  })

  it('tears down the environment the DEPLOYER recorded, never one re-resolved from the frame', async () => {
    // The invariant the whole design rests on. Re-resolving by (block, frame) falls back to the
    // block's frame-less row — a manual or `human-test` environment — once the frame's own row is
    // gone, so a disposer that re-resolved would destroy an environment this run never stood up
    // and book it as this frame's clean reclaim.
    const { controller, teardowns } = harness({
      teardown: async () => ({ confirmation: 'confirmed', reason: null, handle: {} }),
    })
    const disposer = step({ agentKind: 'disposer' })

    await controller.runDisposerStep(
      'ws_1',
      instanceWith([deployed, disposer]),
      disposer,
      BLOCK,
      true,
    )

    expect(teardowns).toEqual(['env_api'])
  })

  it('reclaims the LATEST environment when a frame was deployed more than once', async () => {
    // A re-deploy after a fix supersedes the first environment, so the second id is the live one.
    // Tearing down the superseded id would hit a tombstone and leave the real environment running
    // while the summary reported a clean sweep.
    const { controller, teardowns } = harness({
      teardown: async () => ({ confirmation: 'confirmed', reason: null, handle: {} }),
    })
    const redeployed = step({
      agentKind: 'deployer',
      deployEnvs: { frm_api: { status: 'ready', environmentId: 'env_api_v2' } },
    })
    const disposer = step({ agentKind: 'disposer' })

    await controller.runDisposerStep(
      'ws_1',
      instanceWith([deployed, redeployed, disposer]),
      disposer,
      BLOCK,
      true,
    )

    expect(teardowns).toEqual(['env_api_v2'])
  })

  it('refuses to guess when the deploy recorded no environment id', async () => {
    // A run that was already in flight when ids started being recorded. `none` would read as
    // "there was nothing to do" about an environment that is probably still running and billing,
    // so it is reported as an un-reclaimed frame with the reason named.
    const { controller, teardowns } = harness({ teardown: async () => ({}) })
    const legacy = step({
      agentKind: 'deployer',
      deployEnvs: { frm_api: { status: 'ready', url: 'https://api.test' } },
    })
    const disposer = step({ agentKind: 'disposer' })

    await controller.runDisposerStep(
      'ws_1',
      instanceWith([legacy, disposer]),
      disposer,
      BLOCK,
      true,
    )

    expect(teardowns).toEqual([])
    expect(disposer.disposeEnvs?.frm_api).toMatchObject({
      status: 'failed',
      error: expect.stringContaining('no environment id'),
    })
  })

  it('resumes at the first un-settled frame on a replay', async () => {
    // The teardown call has no idempotency guard, so a replay that re-tore-down an already
    // settled frame would hit the provider a second time for an environment already gone.
    const teardown = vi.fn(async () => ({ confirmation: 'confirmed', reason: null, handle: {} }))
    const { controller } = harness({ teardown })
    const disposer = step({
      agentKind: 'disposer',
      disposeEnvs: { frm_api: { status: 'reclaimed', environmentId: 'env_api' } },
    })

    await controller.runDisposerStep(
      'ws_1',
      instanceWith([deployed, disposer]),
      disposer,
      BLOCK,
      true,
    )

    expect(teardown).not.toHaveBeenCalled()
  })

  it('passes through when the environment integration is unwired', async () => {
    const { controller, results } = harness(null)
    const disposer = step({ agentKind: 'disposer' })

    await controller.runDisposerStep(
      'ws_1',
      instanceWith([deployed, disposer]),
      disposer,
      BLOCK,
      true,
    )

    expect(disposer.disposeEnvs?.frm_api).toEqual({ status: 'none' })
    expect(results[0]?.output).toContain('nothing to reclaim')
  })
})
