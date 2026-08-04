import type { Block, ExecutionInstance, PipelineStep } from '@cat-factory/kernel'
import type { AgentKindRegistry } from '@cat-factory/agents'
import type { AdvanceResult } from './advance.js'
import type { InputGateController } from './InputGateController.js'
import type { RunStateMachine } from './RunStateMachine.js'
import type { StepGraph } from './StepGraph.js'
import { isReentrantDecisionResume } from './reentrancy.logic.js'
import { producerWasSkipped, shouldRunGatedStep } from './stepGating.logic.js'

// The FIXED run-lifecycle preamble every step clears before the per-kind handler may dispatch
// it: the checks that decide whether this step runs AT ALL, in the order money is at stake.
//
//   1. the SPEND gate      (is there budget for this step?)
//   2. the DECISION park   (is a human still holding this step?)
//   3. the INPUT gate      (is there anything in the task to act on?)
//   4. ESTIMATE gating     (does this step apply to a task this size?)
//
// They live together, and outside `ExecutionService`, because the ORDER is the design and the
// family keeps growing: each is a reason to stop before dispatching, and each new one is another
// place a future reader has to notice that everything below it costs money. Extracted when the
// input gate joined them (docs/initiatives/pre-dispatch-input-gate.md).
//
// Deps arrive as bound callbacks and collaborators, so this module depends on no concrete
// repository. Behaviour is identical to the inline preamble it replaces.

export interface StepPreambleDeps {
  spend: {
    isOverBudget: (
      workspaceId: string,
      scope: { accountId?: string | null; userId?: string | null },
    ) => Promise<boolean>
  }
  /** `WorkspaceRepository.accountOf` — the budget scope's account. */
  accountOf: (workspaceId: string) => Promise<string | null | undefined>
  /** `RunDispatcher.currentStepIsNonMetered` — the spend gate's exemption. */
  currentStepIsNonMetered: (
    workspaceId: string,
    instance: ExecutionInstance,
    step: PipelineStep,
  ) => Promise<boolean>
  /** `RunDispatcher.skipGatedStep` — finishes an estimate-gated-out step as `skipped`. */
  skipGatedStep: (
    workspaceId: string,
    instance: ExecutionInstance,
    step: PipelineStep,
    isFinalStep: boolean,
  ) => Promise<AdvanceResult>
  /** `BlockRepository.get` — the block every downstream handler reads, fetched once here. */
  blockOf: (workspaceId: string, blockId: string) => Promise<Block | null>
  stateMachine: RunStateMachine
  stepGraph: StepGraph
  inputGate: InputGateController
  agentKindRegistry: AgentKindRegistry
}

/**
 * What the preamble decided. `proceed` carries the block every downstream handler needs (read
 * once here rather than again per handler); `stop` carries the {@link AdvanceResult} the driver
 * acts on. A discriminated result rather than a nullable one, because "keep going" has a payload
 * and "we are done" has a different one, and a caller must not be able to reach for the wrong
 * half.
 */
export type StepPreambleOutcome =
  | { kind: 'proceed'; block: Block; isFinalStep: boolean }
  | { kind: 'stop'; result: AdvanceResult }

/**
 * Run the four pre-dispatch checks for a step, in order.
 *
 * The ORDER is load-bearing twice over. The spend gate is first because a run over budget must
 * not do work of any kind, including the reads below it. The input gate sits immediately before
 * the handler dispatch because that is the last point at which the run has cost NOTHING: the
 * estimate-gating skip beneath it spends no tokens either, but everything past
 * `dispatchStepHandler` does.
 */
export async function runStepPreamble(
  deps: StepPreambleDeps,
  workspaceId: string,
  instance: ExecutionInstance,
  step: PipelineStep,
): Promise<StepPreambleOutcome> {
  // Spend gate: don't incur monetary LLM cost once the budget is exhausted. Pause the run (so
  // the frontend can flag it) and stop here. A previously-paused run that finds the budget has
  // freed up resumes and proceeds. EXEMPTION: a step that incurs no metered monetary cost (a
  // flat-rate subscription like Claude Code / Codex, or a local-runner model, keyless on the
  // user's own endpoint) never contributes to the budget, so it must not be held hostage by a
  // budget other (metered) models exhausted. This is what lets a deliberately local-only /
  // subscription-only workspace keep running at a `0` budget (see the spend-budget docs).
  const budgetAccountId = await deps.accountOf(workspaceId)
  if (
    await deps.spend.isOverBudget(workspaceId, {
      accountId: budgetAccountId,
      userId: instance.initiatedBy,
    })
  ) {
    if (!(await deps.currentStepIsNonMetered(workspaceId, instance, step))) {
      if (instance.status !== 'paused') {
        instance.status = 'paused'
        await deps.stateMachine.casPersist(workspaceId, instance)
        await deps.stateMachine.emitInstance(workspaceId, instance)
        // Surface the pause in the inbox (F3): a `paused` run is invisible to the sweeper and
        // has no auto-resume, so without this card the paused board badge is its only signal.
        await deps.stateMachine.raiseBudgetPaused(workspaceId)
      }
      return { kind: 'stop', result: { kind: 'paused' } }
    }
  }
  if (instance.status === 'paused') instance.status = 'running'

  if (step.state === 'waiting_decision') {
    // Several gates are re-entrant: a human action sets a `pending*` marker on the parked step
    // and wakes the driver, and the step handler must run the (slow) resume work in the durable
    // driver instead of immediately re-parking on its stale decision id. See
    // {@link isReentrantDecisionResume} for the per-gate cases.
    if (!isReentrantDecisionResume(step, deps.agentKindRegistry)) {
      // Parked on either an agent-raised decision or a human approval gate; both are addressed
      // by the same durable event id.
      const pendingId = step.decision?.id ?? step.approval?.id
      if (pendingId) {
        instance.status = 'blocked'
        await deps.stateMachine.casPersist(workspaceId, instance)
        await deps.stateMachine.emitInstance(workspaceId, instance)
        return { kind: 'stop', result: { kind: 'awaiting_decision', decisionId: pendingId } }
      }
    }
  }
  deps.stepGraph.startStep(step)

  const block = await deps.blockOf(workspaceId, instance.blockId)
  if (!block) return { kind: 'stop', result: { kind: 'noop' } }

  // The PRE-DISPATCH INPUT GATE. Evaluated at most once per run (the verdict on
  // `instance.inputGate` is the guard) and only at step 0; a park here costs nothing because
  // nothing has run yet. `null` means proceed.
  const gated = await deps.inputGate.evaluate(workspaceId, instance, step, block)
  if (gated) return { kind: 'stop', result: gated }

  const isFinalStep = instance.currentStep === instance.steps.length - 1

  // Estimate gating: a step gated on the task estimate is transparently SKIPPED when the
  // estimate (written by an earlier task-estimator step in this same run) falls below the
  // threshold. No agent is spun up; the step finishes as `skipped` and the run advances.
  // Evaluated here rather than at build time, because the estimate only exists once the
  // estimator step has run.
  //
  // A COMPANION whose producer was skipped is skipped for the second reason: with producers now
  // gatable, it would otherwise grade whatever step happens to precede it. Checked alongside its
  // own gate because either reason is sufficient and they need not agree: a companion with no
  // gate of its own still cascades.
  const gatedOut = step.gating?.enabled && !shouldRunGatedStep(block.estimate, step.gating)
  if (gatedOut || producerWasSkipped(instance.steps, instance.currentStep)) {
    return {
      kind: 'stop',
      result: await deps.skipGatedStep(workspaceId, instance, step, isFinalStep),
    }
  }
  return { kind: 'proceed', block, isFinalStep }
}
