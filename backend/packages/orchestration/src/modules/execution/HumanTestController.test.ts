import { describe, expect, it, vi } from 'vitest'
import type { Block, ExecutionInstance, PipelineStep } from '@cat-factory/kernel'
import { HumanTestController, type HumanTestControllerDeps } from './HumanTestController.js'

// The controller owns the human-testing gate's control flow only; every engine primitive +
// the env/branch/executor seams are injected. These fakes record the calls so each branch can
// be asserted without a DB, a durable driver, an LLM or a real environment. The gate NO LONGER
// provisions its own env — it READS the one the upstream `deployer` step provisioned, and
// rebuilds by LOOPING BACK to that deployer. `readEnvironment` is omitted in most tests to drive
// the degraded (manual) mode.

function step(over: Partial<PipelineStep> = {}): PipelineStep {
  return {
    agentKind: 'human-test',
    state: 'running',
    progress: 0,
    ...over,
  } as unknown as PipelineStep
}

function deployerStep(over: Partial<PipelineStep> = {}): PipelineStep {
  return { agentKind: 'deployer', state: 'done', progress: 1, ...over } as unknown as PipelineStep
}

function instance(steps: PipelineStep[], over: Partial<ExecutionInstance> = {}): ExecutionInstance {
  return {
    id: 'exec_1',
    blockId: 'blk_1',
    status: 'running',
    currentStep: 0,
    steps,
    ...over,
  } as unknown as ExecutionInstance
}

const BLOCK = {
  id: 'blk_1',
  executionId: 'exec_1',
  title: 'Login',
  type: 'service',
  description: '',
  pullRequest: { url: 'https://h/pr/1', number: 1, branch: 'feat/login' },
} as unknown as Block

/** A ready environment handle the deployer would have provisioned. */
function readyEnv() {
  return { id: 'env_1', url: 'https://preview.example.com', status: 'ready', expiresAt: 5000 }
}

/** An async fake executor whose `startJob` is a spy (so the helper dispatch can be asserted). */
function fakeExecutor() {
  const startJob = vi.fn(async () => ({ jobId: 'job_1', model: 'fake:model' }))
  return {
    runsAsync: () => true,
    startJob,
    pollJob: vi.fn(),
    runAgent: vi.fn(),
  } as unknown as HumanTestControllerDeps['agentExecutor'] & { startJob: typeof startJob }
}

function fakeDeps(over: Partial<HumanTestControllerDeps> = {}): HumanTestControllerDeps {
  return {
    blockRepository: { get: vi.fn(async () => BLOCK) } as never,
    executionRepository: { get: vi.fn(async () => null), upsert: vi.fn(async () => {}) } as never,
    workRunner: { signalDecision: vi.fn(async () => {}) } as never,
    agentExecutor: fakeExecutor(),
    contextBuilder: {
      buildContext: vi.fn(async () => ({ agentKind: 'human-test', priorOutputs: [] })),
    } as never,
    resolveRiskPolicy: vi.fn(async () => ({ ciMaxAttempts: 10 })),
    // The spine primitives now come from the cohesive RunStateMachine + StepGraph
    // collaborators (debagged), so the fakes group under those two objects.
    stateMachine: {
      parkStepOnDecision: vi.fn(async (_ws, _i, s: PipelineStep) => {
        s.approval = { id: 'appr_1', status: 'pending', proposal: '' }
        s.state = 'waiting_decision'
        return { kind: 'awaiting_decision', decisionId: 'appr_1' } as const
      }),
      updateBlockProgress: vi.fn(async () => {}),
      finalizeBlock: vi.fn(async () => {}),
      stopRunContainer: vi.fn(async () => {}),
      persistInstance: vi.fn(async () => {}),
      emitInstance: vi.fn(async () => {}),
    } as never,
    stepGraph: {
      finishStep: vi.fn((s: PipelineStep) => {
        s.state = 'done'
      }),
      startStep: vi.fn((s: PipelineStep) => {
        s.state = 'working'
      }),
      // Mimics the real StepGraph.rerunRange: reset the range + re-arm the from-step + move cursor.
      rerunRange: vi.fn((inst: ExecutionInstance, from: number, through: number) => {
        for (let i = from; i <= through; i++) {
          const st = inst.steps[i]!
          st.state = 'pending'
          st.jobId = undefined
        }
        inst.steps[from]!.state = 'working'
        inst.currentStep = from
      }),
      // Mimics StepGraph.nearestStepIndexBefore: nearest preceding step matching the predicate.
      nearestStepIndexBefore: vi.fn(
        (steps: PipelineStep[], index: number, predicate: (s: PipelineStep) => boolean) => {
          for (let i = index - 1; i >= 0; i--) if (predicate(steps[i]!)) return i
          return -1
        },
      ),
    } as never,
    clockNow: () => 1000,
    ...over,
  }
}

describe('HumanTestController', () => {
  it('parks in degraded manual mode when no environment provider is wired', async () => {
    const deps = fakeDeps()
    const c = new HumanTestController(deps)
    const s = step()
    const inst = instance([s])

    const result = await c.evaluate('ws', inst, s, BLOCK, true)

    expect(result).toEqual({ kind: 'awaiting_decision', decisionId: 'appr_1' })
    expect(s.humanTest?.phase).toBe('awaiting_human')
    expect(s.humanTest?.environment ?? null).toBeNull()
    expect(s.humanTest?.degradedReason).toBeTruthy()
    expect(deps.stateMachine.parkStepOnDecision).toHaveBeenCalled()
  })

  it('reads the deployer-provisioned env and parks the human when it is ready', async () => {
    const readEnvironment = vi.fn(async () => readyEnv())
    const deps = fakeDeps({ readEnvironment: readEnvironment as never })
    const c = new HumanTestController(deps)
    const s = step()

    const result = await c.evaluate(
      'ws',
      instance([deployerStep(), s], { currentStep: 1 }),
      s,
      BLOCK,
      true,
    )

    expect(readEnvironment).toHaveBeenCalledWith('ws', BLOCK)
    expect(result).toEqual({ kind: 'awaiting_decision', decisionId: 'appr_1' })
    expect(s.humanTest?.phase).toBe('awaiting_human')
    expect(s.humanTest?.environment?.url).toBe('https://preview.example.com')
    expect(s.humanTest?.degradedReason ?? null).toBeNull()
  })

  it('degrades to manual mode when no env was provisioned (deployer skipped / infraless)', async () => {
    const readEnvironment = vi.fn(async () => null)
    const deps = fakeDeps({ readEnvironment: readEnvironment as never })
    const c = new HumanTestController(deps)
    const s = step()

    const result = await c.evaluate('ws', instance([s]), s, BLOCK, true)

    expect(readEnvironment).toHaveBeenCalled()
    expect(result).toEqual({ kind: 'awaiting_decision', decisionId: 'appr_1' })
    expect(s.humanTest?.phase).toBe('awaiting_human')
    expect(s.humanTest?.environment ?? null).toBeNull()
    expect(s.humanTest?.degradedReason).toBeTruthy()
    // It NEVER provisions — the deployer is the single provisioner.
    expect(deps.stateMachine.parkStepOnDecision).toHaveBeenCalled()
  })

  it('re-reads the freshly-rebuilt env on re-entry (repurposed provisioning phase)', async () => {
    const readEnvironment = vi.fn(async () => readyEnv())
    const deps = fakeDeps({ readEnvironment: readEnvironment as never })
    const c = new HumanTestController(deps)
    // A loop-back left the gate in `provisioning`; control returned after the deployer rebuilt.
    const s = step({
      state: 'pending',
      humanTest: {
        phase: 'provisioning',
        environment: null,
        attempts: 1,
        maxAttempts: 10,
        rounds: [],
      },
    })

    const result = await c.evaluate(
      'ws',
      instance([deployerStep(), s], { currentStep: 1 }),
      s,
      BLOCK,
      true,
    )

    expect(readEnvironment).toHaveBeenCalled()
    expect(result).toEqual({ kind: 'awaiting_decision', decisionId: 'appr_1' })
    expect(s.humanTest?.phase).toBe('awaiting_human')
    expect(s.humanTest?.environment?.url).toBe('https://preview.example.com')
    // The fix-attempt budget carried across the loop-back.
    expect(s.humanTest?.attempts).toBe(1)
  })

  it('dispatches the fixer (and records the round) on a request-fix action', async () => {
    const deps = fakeDeps()
    const c = new HumanTestController(deps)
    const s = step({
      state: 'waiting_decision',
      humanTest: {
        phase: 'awaiting_human',
        environment: null,
        attempts: 0,
        maxAttempts: 10,
        rounds: [],
        pendingAction: { type: 'request-fix', findings: 'Button broken' },
      },
    })

    const result = await c.evaluate(
      'ws',
      instance([deployerStep(), s], { currentStep: 1 }),
      s,
      BLOCK,
      true,
    )

    expect(
      (deps.agentExecutor as unknown as { startJob: ReturnType<typeof vi.fn> }).startJob,
    ).toHaveBeenCalled()
    const ctx = (deps.agentExecutor as unknown as { startJob: ReturnType<typeof vi.fn> }).startJob
      .mock.calls[0]![0]
    expect(ctx.agentKind).toBe('fixer')
    expect(result).toEqual({ kind: 'awaiting_job', jobId: 'job_1', stepIndex: 1 })
    expect(s.humanTest?.phase).toBe('fixing')
    expect(s.humanTest?.attempts).toBe(1)
    expect(s.humanTest?.rounds?.[0]).toMatchObject({
      kind: 'fix',
      helperKind: 'fixer',
      findings: 'Button broken',
    })
    expect(s.humanTest?.pendingAction ?? null).toBeNull()
    // While the helper runs the step leaves the parked decision state (working + no pending
    // approval), so a re-drive through `advance` re-attaches to the job instead of re-parking
    // on the stale approval and abandoning the helper.
    expect(s.state).toBe('working')
    expect(s.approval ?? null).toBeNull()
  })

  it('re-attaches to an in-flight helper job on replay (no pending action)', async () => {
    const deps = fakeDeps()
    const c = new HumanTestController(deps)
    // A fixer is in flight: working, no pending action, a live jobId.
    const s = step({
      state: 'working',
      jobId: 'job_42',
      humanTest: {
        phase: 'fixing',
        environment: null,
        attempts: 1,
        maxAttempts: 10,
        rounds: [
          {
            kind: 'fix',
            findings: 'x',
            helperKind: 'fixer',
            jobId: 'job_42',
            outcome: null,
            at: 1,
          },
        ],
      },
    })

    const result = await c.evaluate('ws', instance([s]), s, BLOCK, true)

    expect(result).toEqual({ kind: 'awaiting_job', jobId: 'job_42', stepIndex: 0 })
    expect(deps.stateMachine.parkStepOnDecision).not.toHaveBeenCalled()
  })

  it('loops back to the deployer when a fixer helper completes (rebuild the env)', async () => {
    const deps = fakeDeps({ readEnvironment: vi.fn(async () => readyEnv()) as never })
    const c = new HumanTestController(deps)
    const dep = deployerStep()
    const s = step({
      state: 'working',
      jobId: 'job_7',
      humanTest: {
        phase: 'fixing',
        environment: null,
        attempts: 1,
        maxAttempts: 10,
        rounds: [
          { kind: 'fix', findings: 'x', helperKind: 'fixer', jobId: 'job_7', outcome: null, at: 1 },
        ],
      },
    })
    const inst = instance([dep, s], { currentStep: 1 })

    const result = await c.onHelperComplete('ws', inst, s, { state: 'done' })

    // Loops back to the deployer step: cursor moved, range reset, continue re-drives.
    expect(result).toEqual({ kind: 'continue' })
    expect(inst.currentStep).toBe(0)
    expect(deps.stepGraph.rerunRange).toHaveBeenCalledWith(inst, 0, 1)
    // The gate is re-seeded to re-read the env on re-entry, preserving the attempt budget.
    expect(s.humanTest?.phase).toBe('provisioning')
    expect(s.humanTest?.attempts).toBe(1)
    expect(s.humanTest?.environment ?? null).toBeNull()
  })

  it('loops back to the deployer on a recreate action', async () => {
    const deps = fakeDeps({ readEnvironment: vi.fn(async () => readyEnv()) as never })
    const c = new HumanTestController(deps)
    const dep = deployerStep()
    const s = step({
      state: 'waiting_decision',
      humanTest: {
        phase: 'awaiting_human',
        environment: { id: 'env_1', url: 'https://old.example.com', status: 'ready' },
        attempts: 2,
        maxAttempts: 10,
        rounds: [],
        pendingAction: { type: 'recreate' },
      },
    })
    const inst = instance([dep, s], { currentStep: 1 })

    const result = await c.evaluate('ws', inst, s, BLOCK, true)

    expect(result).toEqual({ kind: 'continue' })
    expect(inst.currentStep).toBe(0)
    expect(s.humanTest?.phase).toBe('provisioning')
    expect(s.humanTest?.attempts).toBe(2)
    expect(s.humanTest?.environment ?? null).toBeNull()
  })

  it('degrades to manual mode on recreate when no deployer precedes the gate', async () => {
    const deps = fakeDeps({ readEnvironment: vi.fn(async () => readyEnv()) as never })
    const c = new HumanTestController(deps)
    // No deployer step before the gate → nothing to rebuild through.
    const s = step({
      state: 'waiting_decision',
      humanTest: {
        phase: 'awaiting_human',
        environment: null,
        attempts: 0,
        maxAttempts: 10,
        rounds: [],
        pendingAction: { type: 'recreate' },
      },
    })

    const result = await c.evaluate('ws', instance([s]), s, BLOCK, true)

    expect(deps.stepGraph.rerunRange).not.toHaveBeenCalled()
    expect(result).toEqual({ kind: 'awaiting_decision', decisionId: 'appr_1' })
    expect(s.humanTest?.degradedReason).toBeTruthy()
  })

  it('refuses request-fix once the fix-attempt ceiling is reached', async () => {
    const s = step({
      state: 'waiting_decision',
      approval: { id: 'appr_1', status: 'pending', proposal: '' },
      humanTest: {
        phase: 'awaiting_human',
        environment: null,
        attempts: 10,
        maxAttempts: 10,
        rounds: [],
      },
    })
    const inst = instance([s])
    const deps = fakeDeps({
      executionRepository: { get: vi.fn(async () => inst), upsert: vi.fn(async () => {}) } as never,
    })
    const c = new HumanTestController(deps)

    await expect(c.requestFix('ws', 'blk_1', 'one more thing')).rejects.toThrow(/fix-attempt limit/)
    // No action was recorded and the driver was not woken.
    expect(s.humanTest?.pendingAction ?? null).toBeNull()
    expect(deps.workRunner.signalDecision).not.toHaveBeenCalled()
  })

  it('destroys the env locally during a deployer rebuild (transient provisioning phase)', async () => {
    const teardownEnvironment = vi.fn(async () => {})
    const s = step({
      state: 'pending',
      humanTest: {
        phase: 'provisioning',
        environment: { id: 'env_9', url: null, status: 'provisioning' },
        attempts: 1,
        maxAttempts: 10,
        rounds: [],
      },
    })
    const inst = instance([deployerStep({ state: 'working' }), s], { currentStep: 0 })
    const deps = fakeDeps({
      teardownEnvironment,
      executionRepository: { get: vi.fn(async () => inst), upsert: vi.fn(async () => {}) } as never,
    })
    const c = new HumanTestController(deps)

    await c.destroyEnvironment('ws', 'blk_1')

    expect(teardownEnvironment).toHaveBeenCalledWith('ws', 'env_9')
    expect(s.humanTest?.environment ?? null).toBeNull()
  })

  it('advances the run (and tears the env down) on a confirm action', async () => {
    const teardownEnvironment = vi.fn(async () => {})
    const deps = fakeDeps({
      teardownEnvironment,
      notificationService: { listOpen: vi.fn(async () => []) } as never,
    })
    const c = new HumanTestController(deps)
    const s = step({
      state: 'waiting_decision',
      approval: { id: 'appr_1', status: 'pending', proposal: '' },
      humanTest: {
        phase: 'awaiting_human',
        environment: { id: 'env_1', url: 'https://x', status: 'ready' },
        attempts: 0,
        maxAttempts: 10,
        rounds: [],
        pendingAction: { type: 'confirm' },
      },
    })
    const inst = instance([s])

    const result = await c.evaluate('ws', inst, s, BLOCK, true)

    expect(teardownEnvironment).toHaveBeenCalledWith('ws', 'env_1')
    expect(deps.stepGraph.finishStep).toHaveBeenCalledWith(s)
    expect(inst.status).toBe('done')
    expect(result).toEqual({ kind: 'done' })
    expect(s.humanTest?.phase).toBe('passed')
  })

  it('dispatches the conflict-resolver when pull-main conflicts, else loops back to the deployer', async () => {
    // Conflict path: dispatch the resolver.
    const conflictDeps = fakeDeps({
      readEnvironment: vi.fn(async () => readyEnv()) as never,
      branchUpdater: { updateFromBase: vi.fn(async () => 'conflict') } as never,
    })
    const c1 = new HumanTestController(conflictDeps)
    const s1 = step({
      state: 'waiting_decision',
      humanTest: {
        phase: 'awaiting_human',
        environment: null,
        attempts: 0,
        maxAttempts: 10,
        rounds: [],
        pendingAction: { type: 'pull-main' },
      },
    })
    const r1 = await c1.evaluate(
      'ws',
      instance([deployerStep(), s1], { currentStep: 1 }),
      s1,
      BLOCK,
      true,
    )
    const ctx = (conflictDeps.agentExecutor as unknown as { startJob: ReturnType<typeof vi.fn> })
      .startJob.mock.calls[0]![0]
    expect(ctx.agentKind).toBe('conflict-resolver')
    expect(r1).toEqual({ kind: 'awaiting_job', jobId: 'job_1', stepIndex: 1 })
    expect(s1.humanTest?.phase).toBe('resolving_conflicts')

    // Clean merge path: no helper, loop back to the deployer to rebuild.
    const cleanDeps = fakeDeps({
      readEnvironment: vi.fn(async () => readyEnv()) as never,
      branchUpdater: { updateFromBase: vi.fn(async () => 'merged') } as never,
    })
    const c2 = new HumanTestController(cleanDeps)
    const s2 = step({
      state: 'waiting_decision',
      humanTest: {
        phase: 'awaiting_human',
        environment: null,
        attempts: 0,
        maxAttempts: 10,
        rounds: [],
        pendingAction: { type: 'pull-main' },
      },
    })
    const inst2 = instance([deployerStep(), s2], { currentStep: 1 })
    const r2 = await c2.evaluate('ws', inst2, s2, BLOCK, true)
    expect(
      (cleanDeps.agentExecutor as unknown as { startJob: ReturnType<typeof vi.fn> }).startJob,
    ).not.toHaveBeenCalled()
    expect(r2).toEqual({ kind: 'continue' })
    expect(inst2.currentStep).toBe(0)
  })
})
