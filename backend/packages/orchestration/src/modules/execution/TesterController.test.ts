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
  const persistInstance = vi.fn(async () => {})
  const startJob = vi.fn(async () => ({ jobId: 'j1' }))
  const deps = {
    blockRepository: { get: async () => block() },
    notificationService: { raise },
    agentExecutor: { startJob, pollJob: vi.fn(), stopJob: vi.fn() },
    contextBuilder: { buildContext: vi.fn() },
    resolveMergePreset: async () => ({ ciMaxAttempts: 10 }),
    stateMachine: {
      persistInstance,
      emitInstance: vi.fn(async () => {}),
      stopRunContainer: vi.fn(async () => {}),
    },
    ...over,
  } as unknown as TesterControllerDeps
  return { controller: new TesterController(deps), raise, persistInstance, startJob }
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
