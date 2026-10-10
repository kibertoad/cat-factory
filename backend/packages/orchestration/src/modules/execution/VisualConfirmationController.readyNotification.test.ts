import { describe, expect, it, vi } from 'vitest'
import type { Block, ExecutionInstance, PipelineStep } from '@cat-factory/kernel'
import {
  VisualConfirmationController,
  type VisualConfirmationControllerDeps,
} from './VisualConfirmationController.js'

// The gate's inbox half: approving the screenshots settles the "ready for review" card the gate
// raised when it parked. Only the settle is exercised here — the gallery fold is next door in
// VisualConfirmationController.designReferences.test.ts.
//
// Worth its own file because the settle is one line with three chances to be silently wrong (the
// type string, the block id, the action), and every one of them fails the same way: the card stays
// open in the inbox and the escalation sweep flips it red for a gate that already passed. Nothing
// else in the suite would notice.

const BLOCK = { id: 'blk_1', executionId: 'exec_1', title: 'Checkout' } as unknown as Block

function approvedStep(): PipelineStep {
  return {
    agentKind: 'visual-confirmation',
    state: 'waiting_decision',
    progress: 0,
    visualConfirm: {
      phase: 'awaiting_human',
      pairs: [],
      attempts: 0,
      maxAttempts: 3,
      rounds: [],
      pendingAction: { type: 'approve' },
    },
  } as unknown as PipelineStep
}

function makeDeps(clearOnBlock: ReturnType<typeof vi.fn>) {
  return {
    blockRepository: { get: vi.fn(async () => BLOCK) } as never,
    executionRepository: { get: vi.fn(async () => null), upsert: vi.fn(async () => {}) } as never,
    workRunner: { signalDecision: vi.fn(async () => {}) } as never,
    agentExecutor: { runsAsync: () => true, startJob: vi.fn() } as never,
    contextBuilder: { buildContext: vi.fn() } as never,
    resolveRiskPolicy: vi.fn(async () => ({ ciMaxAttempts: 3 })),
    notificationService: { clearOnBlock } as never,
    stateMachine: {
      casPersist: vi.fn(async () => {}),
      finishHumanGateStep: vi.fn((s: PipelineStep) => {
        s.state = 'done'
      }),
      settleStepAndAdvance: vi.fn(async () => ({ kind: 'done' }) as const),
    } as never,
    stepGraph: {} as never,
    clockNow: () => 1000,
  } as unknown as VisualConfirmationControllerDeps
}

describe('VisualConfirmationController ready-notification clear', () => {
  it('settles the block card as ACTED when the human approves', async () => {
    const clearOnBlock = vi.fn(async () => null)
    const deps = makeDeps(clearOnBlock)
    const step = approvedStep()
    const instance = {
      id: 'exec_1',
      blockId: 'blk_1',
      status: 'running',
      currentStep: 0,
      steps: [step],
    } as unknown as ExecutionInstance

    const result = await new VisualConfirmationController(deps).evaluate(
      'ws',
      instance,
      step,
      BLOCK,
      true,
    )

    expect(result).toEqual({ kind: 'done' })
    expect(step.visualConfirm?.phase).toBe('approved')
    // `act`, not `dismiss`: the human did the thing the card asked for, and the inbox renders
    // the two differently. Scoped to THIS block and THIS type, so the merge_review card a
    // stopped run left behind is untouched.
    expect(clearOnBlock).toHaveBeenCalledWith('ws', 'blk_1', 'visual_confirmation_ready', 'act')
  })

  it('is a no-op when the deployment wired no notification service', async () => {
    const deps = makeDeps(vi.fn())
    ;(deps as { notificationService?: unknown }).notificationService = undefined
    const step = approvedStep()
    const instance = {
      id: 'exec_1',
      blockId: 'blk_1',
      status: 'running',
      currentStep: 0,
      steps: [step],
    } as unknown as ExecutionInstance

    // The gate still completes: the inbox is an opt-in surface, so an unwired one costs the
    // card, never the approval.
    await expect(
      new VisualConfirmationController(deps).evaluate('ws', instance, step, BLOCK, true),
    ).resolves.toEqual({ kind: 'done' })
  })
})
