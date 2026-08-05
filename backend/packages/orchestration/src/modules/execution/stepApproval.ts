import type { PipelineStep, StepApproval } from '@cat-factory/kernel'
import { hasApproverPolicy, requiredGateApprovals } from '@cat-factory/kernel'

// ---------------------------------------------------------------------------
// Raising a step's HUMAN approval gate, in ONE place.
//
// Two sites raise this same gate — the ordinary step settle (`RunDispatcher`) and a gated
// COMPANION's settle (`CompanionController`), which raises it on the producer's output once the
// companion has cleared it. They are the same checkpoint, so they must carry the same policy, and
// while each built its own object literal they did not: the companion's copy was written before
// per-step gate config existed and kept raising a bare `{ id, status, proposal }`.
//
// That divergence fails OPEN and silently. An approval with no `approverPolicy` reads to
// `refuseGateResolution` as "anyone the workspace admits to write", and one with no
// `requiredApprovals` reads to `foldGateApproval` as a quorum of one — so a companion step
// configured with named approvers and a two-person quorum saved without complaint and then
// resolved as though it had been configured with nothing.
//
// One builder, so a third raiser cannot drift the same way.
// ---------------------------------------------------------------------------

/**
 * Build the `pending` approval for a step's human gate, snapshotting the gate's configured POLICY
 * out of `stepOptions.gateConfig`.
 *
 * The policy is frozen HERE, at raise time, never re-read when someone approves: the pipeline
 * definition stays editable while a run is parked on it, and a bar that moved under the people
 * already counted toward it is a bar nobody agreed to (the same reasoning that pins a run's
 * initiator role at admission, ADR 0037).
 *
 * Both fields are omitted at their default rather than written explicitly, so an unconfigured gate
 * persists the byte-identical shape it did before per-step gate config existed.
 */
export function buildStepApproval(
  step: Pick<PipelineStep, 'stepOptions'>,
  approvalId: string,
  proposal: string,
): StepApproval {
  const gateConfig = step.stepOptions?.gateConfig
  const requiredApprovals = requiredGateApprovals(gateConfig)
  return {
    id: approvalId,
    status: 'pending',
    proposal,
    ...(requiredApprovals > 1 ? { requiredApprovals } : {}),
    ...(hasApproverPolicy(gateConfig?.approvers) ? { approverPolicy: gateConfig!.approvers } : {}),
  }
}
