import { describe, expect, it, vi } from 'vitest'
import type { Block, ExecutionInstance, PipelineStep } from '@cat-factory/kernel'
import { DeployFixController, describeDeployFailure } from './DeployFixController.js'

// The remediation loop is pure state transition over an in-memory instance plus one dispatch, so
// the collaborators are stubs that record what was asked of them.
//
// What is actually under test is the ADMISSION rule and the give-up, not the happy path. The loop
// spends a container on a coding agent pointed at a checkout, and the whole safety argument is
// that it refuses to do so for any cause an edit in that checkout cannot address. A regression
// there does not fail loudly: it dispatches an agent that finds something plausible to change,
// the run goes green, and the misconfiguration the failure was reporting is hidden.

const MANIFEST_ERROR =
  'Failed to apply Deployment/catalog-api (HTTP 422): Deployment.apps "catalog-api" is invalid: ' +
  'spec.template.spec.containers[0].image: Required value'

function step(overrides: Partial<PipelineStep> = {}): PipelineStep {
  return { agentKind: 'deployer', state: 'running', ...overrides } as PipelineStep
}

function instance(steps: PipelineStep[]): ExecutionInstance {
  return {
    id: 'exec_1',
    blockId: 'task_1',
    status: 'running',
    currentStep: 0,
    pipelineName: 'pl_build',
    steps,
  } as ExecutionInstance
}

const block = { id: 'task_1', title: 'Add catalog search' } as Block

function failure(overrides: Record<string, unknown> = {}) {
  return {
    frameId: 'frame_1',
    frameTitle: 'catalog-api',
    provisioning: { type: 'kubernetes', manifestSource: { type: 'colocated', path: 'deploy/k8s' } },
    error: MANIFEST_ERROR,
    reason: 'manifest_invalid',
    ...overrides,
  } as never
}

function controller(overrides: Record<string, unknown> = {}) {
  const startJob = vi.fn(async () => ({ jobId: 'job_1', model: 'anthropic:opus', runId: 'exec_1' }))
  const deps = {
    // `isAsyncAgentExecutor` keys off `runsAsync`/`startJob`/`pollJob` all being present.
    agentExecutor: { runsAsync: () => true, startJob, pollJob: vi.fn(), stopJob: vi.fn() },
    contextBuilder: { buildContext: vi.fn(async () => ({ priorOutputs: [], block })) },
    runStateMachine: { persistAndEmit: vi.fn(async () => {}) },
    clock: { now: () => 1_700_000_000_000 },
    notificationService: { raise: vi.fn(async (_ws: string, _input: unknown) => {}) },
    ...overrides,
  }
  // Structural rather than fully typed: the controller reads a handful of methods off each
  // collaborator, and a full fake of every engine port would test the fakes.
  return { controller: new DeployFixController(deps as never), deps, startJob }
}

function escalate(c: ReturnType<typeof controller>, s: PipelineStep, f = failure()) {
  return c.controller.escalate({
    workspaceId: 'ws_1',
    instance: instance([s]),
    step: s,
    block,
    isFinalStep: false,
    failure: f,
  })
}

describe('escalate: the admission rule', () => {
  it('dispatches the fixer and parks the run for a manifest the platform rejected', async () => {
    const c = controller()
    const s = step()
    const result = await escalate(c, s)

    expect(result).toEqual({ kind: 'awaiting_job', jobId: 'job_1', stepIndex: 0 })
    expect(c.startJob).toHaveBeenCalledTimes(1)
    expect(s.deployFix).toMatchObject({
      phase: 'fixing',
      attempts: 1,
      maxAttempts: 2,
      frameId: 'frame_1',
      reason: 'manifest_invalid',
    })
    // Provisioning settles on the durable poll path, which rebuilds the handle from the STEP
    // alone: without this the run's spend lands against nobody.
    expect(s.model).toBe('anthropic:opus')
    expect(s.dispatches?.some((d) => d.agentKind === 'deploy-fixer')).toBe(true)
  })

  // The motivating failure. `config_incomplete` is a `{{placeholder}}` the workspace connection
  // never filled, and the only edit available in the checkout is to hard-code the value the
  // substitution exists to vary.
  it.each([
    ['config_incomplete'],
    ['image_unavailable'],
    ['workload_unhealthy'],
    ['permission_denied'],
    ['cluster_unreachable'],
    ['deploy_runner_unwired'],
    ['timeout'],
  ])('refuses to dispatch for %s and leaves the failure terminal', async (reason) => {
    const c = controller()
    const s = step()
    expect(await escalate(c, s, failure({ reason }))).toBeNull()
    expect(c.startJob).not.toHaveBeenCalled()
    expect(s.deployFix).toBeUndefined()
    // No card either: the loop never ran, so there is no give-up to report.
    expect(c.deps.notificationService.raise).not.toHaveBeenCalled()
  })

  // "We could not tell what went wrong" is not evidence that a checkout edit would help. A
  // provider that has not adopted the classification must never be read as having asserted one.
  it('refuses an UNCLASSIFIED failure', async () => {
    const c = controller()
    const s = step()
    expect(await escalate(c, s, failure({ reason: undefined }))).toBeNull()
    expect(c.startJob).not.toHaveBeenCalled()
  })

  it('refuses when the step author disabled the loop, and raises no card', async () => {
    const c = controller()
    const s = step({ stepOptions: { deployFix: { enabled: false } } } as Partial<PipelineStep>)
    expect(await escalate(c, s)).toBeNull()
    expect(c.startJob).not.toHaveBeenCalled()
    expect(c.deps.notificationService.raise).not.toHaveBeenCalled()
  })

  // The fixer is a container job. An executor that cannot start one has nothing to dispatch, and
  // the deployment failure is reported exactly as it would be with no loop wired at all.
  it('falls through when the executor cannot run async jobs', async () => {
    const c = controller({ agentExecutor: { run: vi.fn() } })
    const s = step()
    expect(await escalate(c, s)).toBeNull()
    expect(s.deployFix).toBeUndefined()
    expect(c.deps.notificationService.raise).not.toHaveBeenCalled()
  })

  // A dispatch failure is a fact about the REMEDIATION; the run's actual problem is still the
  // provision that broke, so the caller reports that and this reports nothing.
  it('falls through when the dispatch fails', async () => {
    const c = controller({
      agentExecutor: {
        runsAsync: () => true,
        startJob: vi.fn(async () => {
          throw new Error('no pull request to clone')
        }),
        pollJob: vi.fn(),
        stopJob: vi.fn(),
      },
    })
    const s = step()
    expect(await escalate(c, s)).toBeNull()
    expect(s.deployFix).toBeUndefined()
    expect(c.deps.notificationService.raise).not.toHaveBeenCalled()
  })
})

describe('escalate: the give-up', () => {
  it('raises deploy_blocked once the budget is spent and stays terminal', async () => {
    const c = controller()
    const s = step({
      deployFix: {
        phase: 'retrying',
        attempts: 2,
        maxAttempts: 2,
        frameId: 'frame_1',
        reason: 'manifest_invalid',
        lastError: MANIFEST_ERROR,
      },
    } as Partial<PipelineStep>)

    // Null, so the caller takes its ordinary terminal-failure path: the run FAILS, it does not
    // park waiting for somebody to confirm anything.
    expect(await escalate(c, s)).toBeNull()
    expect(c.startJob).not.toHaveBeenCalled()
    expect(c.deps.notificationService.raise).toHaveBeenCalledTimes(1)
    const raised = c.deps.notificationService.raise.mock.calls[0]?.[1] as Record<string, unknown>
    expect(raised).toMatchObject({
      type: 'deploy_blocked',
      blockId: 'task_1',
      executionId: 'exec_1',
    })
    expect(raised.body).toContain('2 time(s)')
  })

  // The bar is frozen at the first escalation. Re-resolving it from `stepOptions` would let an
  // author editing the pipeline mid-run move the bar the spent rounds were counted against.
  it('measures against the FROZEN bar, not a budget raised mid-run', async () => {
    const c = controller()
    const s = step({
      stepOptions: { deployFix: { maxAttempts: 5 } },
      deployFix: {
        phase: 'retrying',
        attempts: 2,
        maxAttempts: 2,
        frameId: 'frame_1',
        reason: 'manifest_invalid',
        lastError: MANIFEST_ERROR,
      },
    } as Partial<PipelineStep>)

    expect(await escalate(c, s)).toBeNull()
    expect(c.startJob).not.toHaveBeenCalled()
  })

  // The card is best-effort: the run's real problem is the provision that broke, so a
  // notification backend that is down must not throw out of the deployer's failure path.
  it('still falls through when raising the card throws', async () => {
    const c = controller({
      notificationService: {
        raise: vi.fn(async () => {
          throw new Error('notification store unreachable')
        }),
      },
    })
    const s = step({
      deployFix: {
        phase: 'retrying',
        attempts: 2,
        maxAttempts: 2,
        frameId: 'frame_1',
        reason: 'manifest_invalid',
        lastError: MANIFEST_ERROR,
      },
    } as Partial<PipelineStep>)
    expect(await escalate(c, s)).toBeNull()
  })
})

describe('resolveFixerCompletion', () => {
  function fixing(overrides: Partial<PipelineStep> = {}): PipelineStep {
    return step({
      jobId: 'job_1',
      deployEnvs: { frame_1: { status: 'failed' }, frame_2: { status: 'ready' } },
      deployProvisioning: { type: 'kubernetes' },
      deployFrameId: 'frame_1',
      deployFix: {
        phase: 'fixing',
        attempts: 1,
        maxAttempts: 2,
        frameId: 'frame_1',
        reason: 'manifest_invalid',
        lastError: MANIFEST_ERROR,
      },
      ...overrides,
    } as Partial<PipelineStep>)
  }

  function settle(c: ReturnType<typeof controller>, s: PipelineStep, update: unknown) {
    return c.controller.resolveFixerCompletion({
      workspaceId: 'ws_1',
      instance: instance([s]),
      step: s,
      update: update as never,
    })
  }

  // Clearing the frame's TERMINAL outcome is what makes the re-provision happen: the deployer's
  // fan-out resumes at the first frame with none recorded, so it needs no knowledge of this loop.
  it('clears only the failed frame and re-enters the deployer', async () => {
    const c = controller()
    const s = fixing()
    const result = await settle(c, s, { state: 'done', result: { output: 'Fixed the image key.' } })

    expect(result).toEqual({ kind: 'continue' })
    expect(s.deployEnvs).toEqual({ frame_2: { status: 'ready' } })
    // A retry must resolve the frame fresh: the fixer may well have changed what it declares.
    expect(s.deployProvisioning).toBeUndefined()
    expect(s.deployFrameId).toBeUndefined()
    // Dropped so a replay re-attaches to nothing and the deployer's re-entry is not read as one.
    expect(s.jobId).toBeUndefined()
    expect(s.deployFix?.phase).toBe('retrying')
    expect(s.deployFix?.attemptLog).toEqual([
      {
        attempt: 1,
        at: 1_700_000_000_000,
        outcome: 'completed',
        reason: 'manifest_invalid',
        error: MANIFEST_ERROR,
        summary: 'Fixed the image key.',
      },
    ])
  })

  // A job that died without pushing leaves the same failure to be re-classified on the next pass,
  // which spends the next round rather than inventing a verdict about it.
  it('records a died round and still re-provisions', async () => {
    const c = controller()
    const s = fixing()
    const result = await settle(c, s, { state: 'failed', error: 'container evicted' })

    expect(result).toEqual({ kind: 'continue' })
    expect(s.deployEnvs).toEqual({ frame_2: { status: 'ready' } })
    expect(s.deployFix?.attemptLog?.[0]).toMatchObject({
      outcome: 'failed',
      summary: 'container evicted',
    })
  })

  it('appends rather than replacing the earlier rounds', async () => {
    const c = controller()
    const s = fixing({
      deployFix: {
        phase: 'fixing',
        attempts: 2,
        maxAttempts: 2,
        frameId: 'frame_1',
        reason: 'manifest_invalid',
        lastError: MANIFEST_ERROR,
        attemptLog: [
          { attempt: 1, at: 1, outcome: 'completed', reason: 'manifest_invalid', error: 'x' },
        ],
      },
    } as Partial<PipelineStep>)
    await settle(c, s, { state: 'done', result: { output: 'second pass' } })
    expect(s.deployFix?.attemptLog?.map((a) => a.attempt)).toEqual([1, 2])
  })

  // A deployer whose own container job settled must reach the deploy path unchanged.
  it('returns null when no fixer is in flight', async () => {
    const c = controller()
    const s = step({ jobId: 'job_deploy' })
    expect(await settle(c, s, { state: 'done', result: { output: 'deployed' } })).toBeNull()
    expect(s.jobId).toBe('job_deploy')
  })

  it('returns null while a round is still retrying', async () => {
    const c = controller()
    const s = fixing({
      deployFix: {
        phase: 'retrying',
        attempts: 1,
        maxAttempts: 2,
        frameId: 'frame_1',
        reason: 'manifest_invalid',
        lastError: MANIFEST_ERROR,
      },
    } as Partial<PipelineStep>)
    expect(await settle(c, s, { state: 'done', result: { output: 'x' } })).toBeNull()
  })
})

describe('describeDeployFailure', () => {
  // The error alone says what the platform rejected and not where the files that produced it
  // live, and a `separate` manifest source is the one case the fixer's checkout does NOT contain
  // the thing at fault. Left implicit, an agent looks for the manifests in the repo it is
  // standing in and starts writing new ones.
  it('names a separate manifest repository as not-the-checkout', () => {
    const brief = describeDeployFailure(
      failure({
        provisioning: {
          type: 'kubernetes',
          manifestSource: { type: 'separate', repo: 'acme/infra', path: 'k8s', ref: 'main' },
        },
      }),
    )
    expect(brief).toContain("'acme/infra'")
    expect(brief).toContain('NOT the repository you have checked out')
  })

  // A cap that trails off silently reads as an error that genuinely ended there, and the reader
  // concludes the tail was never produced.
  it('states the drop when the provider error is capped', () => {
    const brief = describeDeployFailure(failure({ error: 'x'.repeat(4500) }))
    expect(brief).toContain('500 more characters of this error were not included')
  })

  it('quotes a short error whole', () => {
    expect(describeDeployFailure(failure())).toContain(MANIFEST_ERROR)
  })
})
