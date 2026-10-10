import { describe, expect, it } from 'vitest'
import type {
  AgentJobUpdate,
  Block,
  ExecutionInstance,
  GateDefinition,
  PipelineStep,
} from '@cat-factory/kernel'
import { PollRunningController, type PollRunningControllerDeps } from './PollRunningController.js'
import type { SettledGate } from '../observability/GateOutcomeRecorder.js'

// The INVESTIGATE-don't-fix gate completion (`post-release-health` → `on-call`) is the second
// path a polling gate can reach a terminal verdict down, and it does NOT go through
// `GateStepController`. It shipped recording nothing, which left the gate whose helper is the
// most expensive absent from the operator dashboard's statistics entirely — and absent reads
// exactly like a gate that never escalates.

const GATE = {
  kind: 'post-release-health',
  helperKind: 'on-call',
  resolveHelperCompletion: async () => ({ output: 'investigated' }),
} as unknown as GateDefinition

function step(): PipelineStep {
  return {
    agentKind: 'post-release-health',
    jobId: 'job-1',
    gate: { phase: 'working', attempts: 1, maxAttempts: 3, watchSince: 1_000 },
  } as unknown as PipelineStep
}

function instance(): ExecutionInstance {
  return {
    id: 'exec-1',
    blockId: 'blk-1',
    currentStep: 2,
    steps: [{}, {}, {}],
  } as ExecutionInstance
}

function controller(over: Partial<PollRunningControllerDeps> = {}) {
  const settled: SettledGate[] = []
  const deps = {
    blockRepository: { get: async () => ({ id: 'blk-1' }) as Block },
    gateFor: () => GATE,
    recordGateOutcome: async (s: SettledGate) => {
      settled.push(s)
    },
    recordStepResult: async () => ({ kind: 'noop' }) as never,
    ...over,
  } as unknown as PollRunningControllerDeps
  return { controller: new PollRunningController(deps), settled }
}

const DONE = { state: 'done', result: { output: 'x' } } as unknown as AgentJobUpdate

describe('PollRunningController: investigate-helper gate completion', () => {
  it('records the settled gate for the operator projection', async () => {
    const { controller: c, settled } = controller()
    await c.resolveInvestigateHelperCompletion('ws-1', instance(), step(), DONE)
    expect(settled).toHaveLength(1)
    expect(settled[0]).toMatchObject({
      workspaceId: 'ws-1',
      stepIndex: 2,
      helperKind: 'on-call',
      // `exhausted` is the bucket for "the gate ended without the precheck going green and a
      // human owns the outcome", which is exactly what an on-call hand-off is.
      outcome: 'exhausted',
    })
  })

  it('records a gate whose helper job FAILED, not only a clean investigation', async () => {
    const { controller: c, settled } = controller()
    const failed = { state: 'failed', error: 'boom' } as unknown as AgentJobUpdate
    await c.resolveInvestigateHelperCompletion('ws-1', instance(), step(), failed)
    expect(settled).toHaveLength(1)
    expect(settled[0]?.outcome).toBe('exhausted')
  })

  it('still settles the step when no projection is wired', async () => {
    // The recorder is optional, and an unwired one must cost a dashboard row and nothing else.
    const { controller: c, settled } = controller({ recordGateOutcome: undefined })
    await expect(
      c.resolveInvestigateHelperCompletion('ws-1', instance(), step(), DONE),
    ).resolves.toEqual({ kind: 'noop' })
    expect(settled).toEqual([])
  })

  it('records nothing for a step that is not on this gate path', async () => {
    // No `resolveHelperCompletion` on the gate ⇒ the branch does not apply and the caller falls
    // through to the normal re-probe, which settles (and records) elsewhere.
    const { controller: c, settled } = controller({
      gateFor: () => ({ kind: 'ci', helperKind: 'ci-fixer' }) as unknown as GateDefinition,
    })
    await expect(
      c.resolveInvestigateHelperCompletion('ws-1', instance(), step(), DONE),
    ).resolves.toBeNull()
    expect(settled).toEqual([])
  })
})
