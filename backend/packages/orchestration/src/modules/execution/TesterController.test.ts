import { describe, expect, it, vi } from 'vitest'
import type { AgentRunResult, Block, ExecutionInstance, PipelineStep } from '@cat-factory/kernel'
import { TesterController, type TesterControllerDeps } from './TesterController.js'

const block = (): Block =>
  ({
    id: 'task_login',
    title: 'Login',
    level: 'task',
    status: 'in_progress',
    pullRequest: { url: 'https://gh/pr/1', number: 1, branch: 'cat-factory/task_login' },
  }) as unknown as Block

const instance = (step: PipelineStep): ExecutionInstance =>
  ({
    id: 'exec1',
    blockId: 'task_login',
    pipelineId: 'pl1',
    pipelineName: 'Code + test',
    steps: [step],
    currentStep: 0,
    status: 'running',
    initiatedBy: null,
  }) as unknown as ExecutionInstance

function makeController(over: Partial<TesterControllerDeps> = {}) {
  const raise = vi.fn(async () => ({}) as never)
  const casPersist = vi.fn(async () => {})
  const startJob = vi.fn(async (_context?: unknown) => ({ jobId: 'j1' }))
  const deps = {
    blockRepository: { get: async () => block() },
    notificationService: { raise },
    agentExecutor: { runsAsync: () => true, startJob, pollJob: vi.fn(), stopJob: vi.fn() },
    contextBuilder: { buildContext: vi.fn() },
    resolveRiskPolicy: async () => ({ ciMaxAttempts: 10 }),
    stateMachine: {
      casPersist,
      emitInstance: vi.fn(async () => {}),
      stopRunContainer: vi.fn(async () => {}),
    },
    ...over,
  } as unknown as TesterControllerDeps
  return { controller: new TesterController(deps), raise, casPersist, startJob }
}

describe('TesterController auto-abort on a failed ephemeral environment', () => {
  it('aborts the run (no fixer) when the step environment is in a failed state', async () => {
    // The Tester was configured for an ephemeral environment that never came up, so there is
    // nothing to meaningfully test and no point looping the fixer (it can't provision infra):
    // the engine must STOP the run for a human, leave the step un-`done`, dispatch NO fixer, and
    // carry the provider's error verbatim.
    const step = {
      agentKind: 'tester-api',
      state: 'running',
      test: { phase: 'testing', attempts: 0, maxAttempts: 10, lastReport: null },
      environment: { status: 'failed', lastError: 'env API unreachable: ECONNREFUSED' },
    } as unknown as PipelineStep
    const { controller, raise, startJob } = makeController()

    const result = await controller.resolveTesterResult('ws1', instance(step), step, {
      testReport: { greenlight: true, summary: 'ok', tested: [], outcomes: [], concerns: [] },
    } as unknown as AgentRunResult)

    expect(result).toMatchObject({ kind: 'job_failed', failureKind: 'agent' })
    expect(result?.kind === 'job_failed' && result.detail).toContain('ECONNREFUSED')
    // No fixer was dispatched and the attempt counter did not advance.
    expect(startJob).not.toHaveBeenCalled()
    expect(step.test?.attempts).toBe(0)
    expect(step.test?.attemptLog ?? []).toHaveLength(0)
    // A human-actionable notification was raised.
    expect(raise).toHaveBeenCalledOnce()
  })

  it('falls back to a generic reason when the failed environment carries no error', async () => {
    const step = {
      agentKind: 'tester-api',
      state: 'running',
      test: { phase: 'testing', attempts: 0, maxAttempts: 10, lastReport: null },
      environment: { status: 'failed', lastError: null },
    } as unknown as PipelineStep
    const { controller, startJob } = makeController()

    const result = await controller.resolveTesterResult('ws1', instance(step), step, {
      testReport: { greenlight: false, summary: '', tested: [], outcomes: [], concerns: [] },
    } as unknown as AgentRunResult)

    expect(result).toMatchObject({ kind: 'job_failed', failureKind: 'agent' })
    expect(result?.kind === 'job_failed' && result.detail).toContain('failed to provision')
    expect(startJob).not.toHaveBeenCalled()
  })
})

describe('TesterController test quality-control companion', () => {
  // A greenlit report that claims broad coverage but records a single happy-path outcome —
  // the exact under-reporting the QC companion exists to catch.
  const shallowReport = {
    greenlight: true,
    summary: 'tested the happy path',
    tested: ['happy path', 'validation errors', 'boundaries'],
    outcomes: [{ name: 'happy path', status: 'passed' }],
    concerns: [],
  }

  function qcStep(over: Record<string, unknown> = {}): PipelineStep {
    return {
      agentKind: 'tester-api',
      state: 'running',
      test: { phase: 'testing', attempts: 0, maxAttempts: 10, lastReport: null },
      testerQuality: { enabled: true, attempts: 0, maxAttempts: 3, verdicts: [] },
      ...over,
    } as unknown as PipelineStep
  }

  it('loops the Tester (not the fixer) when the report is judged inadequate, folding the gaps into context', async () => {
    const evaluate = vi.fn(async () => ({
      outcome: {
        adequate: false,
        gaps: ['exercise validation errors', 'exercise boundaries'],
        feedback: 'too shallow',
      },
      model: 'mock:qc',
    }))
    const buildContext = vi.fn(async () => ({ priorOutputs: [] }))
    const step = qcStep()
    const { controller, startJob } = makeController({
      qualityReviewer: { evaluate },
      contextBuilder: { buildContext },
    } as never)

    const result = await controller.resolveTesterResult('ws1', instance(step), step, {
      testReport: shallowReport,
    } as unknown as AgentRunResult)

    // The Tester itself is re-dispatched (a fresh job), NOT the fixer.
    expect(result).toMatchObject({ kind: 'awaiting_job' })
    expect(startJob).toHaveBeenCalledOnce()
    const dispatchedContext = startJob.mock.calls[0]![0] as {
      priorOutputs: { agentKind: string; output: string }[]
    }
    const qcPrior = dispatchedContext.priorOutputs.find((p) => p.agentKind === 'tester-qc')
    expect(qcPrior?.output).toContain('exercise validation errors')
    // QC budget consumed by one re-run; a verdict recorded for the UI.
    expect(step.testerQuality?.attempts).toBe(1)
    expect(step.testerQuality?.verdicts).toHaveLength(1)
    expect(step.testerQuality?.verdicts[0]).toMatchObject({ adequate: false, model: 'mock:qc' })
    // The fixer budget is untouched — this was a coverage loop, not a fix loop.
    expect(step.test?.attempts).toBe(0)
  })

  it('proceeds to the greenlight decision when the report is judged adequate', async () => {
    const evaluate = vi.fn(async () => ({
      outcome: { adequate: true, gaps: [], feedback: 'thorough' },
      model: 'mock:qc',
    }))
    const step = qcStep()
    const { controller, startJob } = makeController({
      qualityReviewer: { evaluate },
      contextBuilder: { buildContext: vi.fn(async () => ({ priorOutputs: [] })) },
    } as never)

    const result = await controller.resolveTesterResult('ws1', instance(step), step, {
      testReport: shallowReport,
    } as unknown as AgentRunResult)

    // Adequate ⇒ QC does not loop; the first-round greenlight (no concerns) is accepted.
    expect(result).toBeNull()
    expect(startJob).not.toHaveBeenCalled()
    expect(step.testerQuality?.attempts).toBe(0)
    expect(step.testerQuality?.verdicts[0]).toMatchObject({ adequate: true })
  })

  it('stops gating once the QC budget is spent and proceeds with the report', async () => {
    const evaluate = vi.fn(async () => ({
      outcome: { adequate: false, gaps: ['still incomplete'], feedback: 'nope' },
      model: 'mock:qc',
    }))
    const step = qcStep({
      testerQuality: { enabled: true, attempts: 3, maxAttempts: 3, verdicts: [] },
    })
    const { controller, startJob } = makeController({
      qualityReviewer: { evaluate },
      contextBuilder: { buildContext: vi.fn(async () => ({ priorOutputs: [] })) },
    } as never)

    const result = await controller.resolveTesterResult('ws1', instance(step), step, {
      testReport: shallowReport,
    } as unknown as AgentRunResult)

    // Budget spent ⇒ QC marks itself exceeded and lets the normal greenlight decision run (null).
    expect(result).toBeNull()
    expect(startJob).not.toHaveBeenCalled()
    expect(step.testerQuality?.exceeded).toBe(true)
  })

  it('is a pass-through when the companion is disabled', async () => {
    const evaluate = vi.fn()
    const step = qcStep({
      testerQuality: { enabled: false, attempts: 0, maxAttempts: 3, verdicts: [] },
    })
    const { controller, startJob } = makeController({ qualityReviewer: { evaluate } } as never)

    const result = await controller.resolveTesterResult('ws1', instance(step), step, {
      testReport: shallowReport,
    } as unknown as AgentRunResult)

    expect(evaluate).not.toHaveBeenCalled()
    expect(result).toBeNull()
    expect(startJob).not.toHaveBeenCalled()
  })
})
