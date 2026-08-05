import type { StepGateConfig, StepOptions } from '@cat-factory/contracts'
import { hasApproverPolicy } from '@cat-factory/contracts'
import type { PipelinesContext } from './context'

/**
 * The pipeline-builder draft's per-step GATE configuration: who may clear a step's human approval
 * gate, how many of them must, and the parameters the step's registered gate declares.
 *
 * Its own module rather than another pair of accessors on `./draftStepConfig`, which owns the flat
 * per-step options (a skill id, a variant id, a token ceiling — each one field, read and written
 * whole). Gate config is the one nested value there: it MERGES a patch across two independently
 * edited halves and normalizes at three levels on the way out, which is a different enough shape to
 * be worth reading on its own. (It also put that file over the per-function line budget, which is
 * the ratchet doing its job rather than a number to raise.)
 */
export function createPipelineGateConfigActions(ctx: PipelinesContext) {
  const { draftStepOptions } = ctx

  /**
   * The gate configuration on the draft step at `index`, or undefined when the step takes every
   * default (one approval from anyone entitled to write, and the gate's shipped knobs).
   */
  function draftGateConfig(index: number): StepGateConfig | undefined {
    return draftStepOptions.value[index]?.gateConfig
  }

  /**
   * Merge a PATCH into the draft step's gate configuration. A patch rather than a whole-value set
   * because the builder edits the two halves through different controls: a whole-value write from
   * the approver fields would drop the gate's own parameters, and vice versa.
   *
   * Normalizes downward at every level: a field set back to its default is deleted, an emptied
   * `gateConfig` is dropped, and an emptied options bag becomes `null`. So a step returned to the
   * defaults persists nothing at all — the same rule the other per-step options follow, and what
   * keeps an all-default pipeline from growing a `step_options` array it does not need.
   *
   * An empty approver policy is dropped rather than stored, and that one is not just tidiness:
   * `{ roles: [] }` names nobody, and a policy naming nobody would refuse every approver and park
   * the run forever. "No rule" has to persist as an ABSENT rule.
   */
  function patchDraftGateConfig(index: number, patch: Partial<StepGateConfig>) {
    const gateConfig: StepGateConfig = { ...draftGateConfig(index), ...patch }
    if (!hasApproverPolicy(gateConfig.approvers)) delete gateConfig.approvers
    if (gateConfig.minApprovals !== undefined && gateConfig.minApprovals <= 1) {
      delete gateConfig.minApprovals
    }
    if (gateConfig.fields && Object.keys(gateConfig.fields).length === 0) delete gateConfig.fields
    const next: StepOptions = { ...draftStepOptions.value[index] }
    if (Object.keys(gateConfig).length) next.gateConfig = gateConfig
    else delete next.gateConfig
    draftStepOptions.value[index] = Object.keys(next).length ? next : null
  }

  return { draftGateConfig, patchDraftGateConfig }
}
