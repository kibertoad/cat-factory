import { describe, expect, it } from 'vitest'
import type { PipelineStep } from '@cat-factory/kernel'
import { buildStepApproval } from './stepApproval.js'

// The gate-raising BUILDER. The companion settle used to hand-roll this literal instead: it predated per-step gate config and kept
// raising a bare `{ id, status, proposal }`, so a companion step configured with named approvers
// and a two-person quorum saved without complaint and then resolved as though it had been
// configured with nothing: a refusal and a quorum both silently absent, failing OPEN.
//
// The structural half of the fix (no raise site may hand-roll the literal again) is
// `scripts/check-gate-approval-raise.mjs`, a repo guard rather than a test here, because this
// package is runtime-neutral and may not read the filesystem.

function step(gateConfig: unknown): Pick<PipelineStep, 'stepOptions'> {
  return { stepOptions: { gateConfig } } as unknown as Pick<PipelineStep, 'stepOptions'>
}

describe('buildStepApproval', () => {
  it('persists the byte-identical shape when the gate configures nothing', () => {
    // Both policy fields are OMITTED at their default rather than written explicitly, so an
    // unconfigured gate's stored approval is what it was before per-step gate config existed.
    expect(buildStepApproval({ stepOptions: undefined }, 'appr_1', 'a proposal')).toEqual({
      id: 'appr_1',
      status: 'pending',
      proposal: 'a proposal',
    })
  })

  it('snapshots the approver policy and the quorum off the step', () => {
    const approval = buildStepApproval(
      step({ approvers: { roles: ['admin'], userIds: ['usr_1'] }, minApprovals: 2 }),
      'appr_1',
      'a proposal',
    )
    expect(approval.requiredApprovals).toBe(2)
    expect(approval.approverPolicy).toEqual({ roles: ['admin'], userIds: ['usr_1'] })
  })

  it('treats a policy that names NOBODY as no policy', () => {
    // `{ roles: [], userIds: [] }` names no one, so storing it would refuse every actor and park
    // the run forever. The builder never writes one; a hand-authored pipeline can.
    const approval = buildStepApproval(
      step({ approvers: { roles: [], userIds: [] } }),
      'appr_1',
      'a proposal',
    )
    expect(approval.approverPolicy).toBeUndefined()
  })

  it('ignores the gate-declared half, which configures a REGISTERED gate and not this one', () => {
    const approval = buildStepApproval(step({ fields: { maxAttempts: 3 } }), 'appr_1', 'p')
    expect(approval).toEqual({ id: 'appr_1', status: 'pending', proposal: 'p' })
  })
})
