import type { PipelineStep } from '@cat-factory/contracts'
import type { AgentRunResult, Clock, ExecutionInstance } from '@cat-factory/kernel'
import type { SpendService } from '@cat-factory/spend'
import type { AgentContextBuilder } from './AgentContextBuilder.js'
import { applyValidationReport } from './validation.logic.js'
import { recordReproductionOutcome } from './reproductionProof.logic.js'

// ---------------------------------------------------------------------------
// Everything the JOB THAT JUST RAN reported about itself — the effort self-assessment, the
// design's foundational-service declaration, the generator's binary-output declaration, the
// pre-PR validation and reproduction proofs, and the usage metering.
//
// Extracted from `RunDispatcher.recordStepResult` as a cohesive collaborator (the file-size /
// statement ratchets' split trigger) because these six share ONE rule that is easy to violate a
// member at a time: each must land BEFORE any of `recordStepResult`'s early-returning paths, or
// the runs whose verdict drives flow — a parked PR review, a companion applying rework, a Tester
// withholding its greenlight, a step raising a human decision — silently drop it. Keeping them in
// one function keeps that rule in one place.
// ---------------------------------------------------------------------------

export interface JobFactsDeps {
  clock: Clock
  spend: SpendService
  contextBuilder: AgentContextBuilder
}

/** Record the facts the just-settled job reported. See the module note for the ordering rule. */
export async function recordJobFacts(
  deps: JobFactsDeps,
  workspaceId: string,
  instance: ExecutionInstance,
  step: PipelineStep,
  result: AgentRunResult,
): Promise<void> {
  // The container agent's effort self-assessment (how hard the work was, what reduced its
  // effectiveness, the obstacles it hit) describes the JOB THAT JUST RAN, so record it before
  // any of the paths below can return early — exactly like the usage metering under it. It
  // used to sit with the normal completion further down, which meant every kind whose verdict
  // drives run flow silently dropped it: a `pr-reviewer` parking on its findings, a container
  // companion applying its verdict, the fork proposer, a Tester withholding its greenlight, a
  // step raising a human decision. Those are the runs whose self-assessment is most worth
  // reading, and none of them ever reaches the normal completion with the result in hand.
  if (result.effortReport) step.effortReport = result.effortReport

  // The FOUNDATIONAL SERVICES this step's design declared, read out of the reply it just
  // returned. Recorded HERE, beside the effort report, for the same reason: every path below can
  // return early (a raised decision, a companion applying a rework loop), and a design step that
  // parks would otherwise lose its declaration — every consumer then reads "nothing was checked".
  // Read back by the context BUILDER, which handed the design its catalog and already holds the
  // resolver + registry, so the completion hub takes no dependency of its own for it.
  await deps.contextBuilder.recordFoundationalDeclaration(workspaceId, step, result.output)

  // The BINARY OUTPUTS a generating step declared it stored, read out of the same reply — the
  // sibling of the foundational declaration above, recorded here for the same reason: a
  // generator that parks on a decision must not lose the record of what it already stored,
  // and every path below can return early.
  await deps.contextBuilder.recordBinaryOutputDeclaration(workspaceId, step, result.output)

  // The pre-PR validation report of a coding step whose service configured checks — recorded
  // here for the same reason as the effort report above: it describes the JOB THAT JUST RAN,
  // so it must land before any early-returning path below. On this (successful) path it is
  // the captured proof the checkout was green BEFORE the PR opened; the failed path records
  // it in `PollCompletionController.handleFailedPoll`.
  applyValidationReport(step, result.validationReport)

  // The BUGFIX REPRODUCTION PROOF of a coding step — the harness's verdict, or (for a run whose
  // reproduction step conceded, which dispatches no proof at all) the structural infeasibility
  // declaration the engine mints itself. Recorded here for the same reason as the validation
  // report above: it describes the JOB THAT JUST RAN, so it must land before any early return.
  recordReproductionOutcome(step, result.reproductionReport, instance, deps.clock.now())

  // Meter the LLM call into the usage ledger. Recorded whether the step completed or
  // raised a decision — both consumed tokens. A subscription-harness result is tagged
  // `'subscription'` so it's counted for the usage report but EXCLUDED from the budget
  // rollups (a flat-rate quota plan costs nothing per token); an inline metered call
  // defaults to `'metered'` and is summed by the spend gate as before.
  if (result.usage) {
    await deps.spend.record({
      workspaceId,
      executionId: instance.id,
      agentKind: step.agentKind,
      model: result.model ?? 'unknown',
      usage: result.usage,
      billing: result.usageBilling ?? 'metered',
      vendor: result.usageVendor ?? null,
    })
  }
}
