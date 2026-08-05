import { describe, expect, it } from 'vitest'
import type { GateActor } from './gate-approval.js'
import {
  foldGateApproval,
  hasApproverPolicy,
  refuseGateResolution,
  requiredGateApprovals,
} from './gate-approval.js'
import { UNATTRIBUTED_GATE_ACTOR } from './gate-config.js'

function user(id: string, role: GateActor['role'] = 'member'): GateActor {
  return { id, kind: 'user', role, label: id }
}

describe('hasApproverPolicy', () => {
  it('treats an absent, empty, or all-empty-arrays policy as no policy', () => {
    // A policy that names nobody must not refuse everybody: it would park the run forever.
    expect(hasApproverPolicy(undefined)).toBe(false)
    expect(hasApproverPolicy({})).toBe(false)
    expect(hasApproverPolicy({ roles: [], userIds: [] })).toBe(false)
    expect(hasApproverPolicy({ roles: ['admin'] })).toBe(true)
    expect(hasApproverPolicy({ userIds: ['usr_1'] })).toBe(true)
  })
})

describe('refuseGateResolution', () => {
  it('permits anyone when no policy is configured, including a key and an unattributed caller', () => {
    for (const actor of [
      user('usr_1'),
      { id: 'pak_1', kind: 'api-key', role: null } as GateActor,
      { id: UNATTRIBUTED_GATE_ACTOR, kind: 'unattributed', role: null } as GateActor,
    ]) {
      expect(refuseGateResolution(undefined, actor)).toBeNull()
    }
  })

  it('admits a listed user and a listed role, and refuses everyone else', () => {
    const policy = { roles: ['admin' as const], userIds: ['usr_release'] }
    expect(refuseGateResolution(policy, user('usr_release'))).toBeNull()
    expect(refuseGateResolution(policy, user('usr_other', 'admin'))).toBeNull()
    expect(refuseGateResolution(policy, user('usr_other'))).toBe('not_a_gate_approver')
  })

  it('always admits a workspace admin, even one the policy does not list', () => {
    // An admin can cancel the run or edit the pipeline outright, so refusing them here buys no
    // safety and would deadlock a gate whose named approvers have left the board.
    expect(refuseGateResolution({ userIds: ['usr_release'] }, user('usr_boss', 'admin'))).toBeNull()
  })

  it('refuses a machine key and an unattributed caller against ANY policy', () => {
    // A shared credential is not one of the people a policy named, and a deployment with auth off
    // has nobody to attribute the approval to — so the honest answer is "this gate needs a person".
    const policy = { roles: ['member' as const] }
    expect(refuseGateResolution(policy, { id: 'pak_1', kind: 'api-key', role: null })).toBe(
      'gate_approver_identity_required',
    )
    expect(
      refuseGateResolution(policy, {
        id: UNATTRIBUTED_GATE_ACTOR,
        kind: 'unattributed',
        role: null,
      }),
    ).toBe('gate_approver_identity_required')
  })
})

describe('requiredGateApprovals', () => {
  it('defaults to one, and floors a hand-authored zero back to one', () => {
    expect(requiredGateApprovals(undefined)).toBe(1)
    expect(requiredGateApprovals({})).toBe(1)
    expect(requiredGateApprovals({ minApprovals: 0 })).toBe(1)
    expect(requiredGateApprovals({ minApprovals: 3 })).toBe(3)
  })
})

describe('foldGateApproval', () => {
  it('satisfies a default gate on the first approval', () => {
    const folded = foldGateApproval({ requiredApprovals: 1 }, user('usr_1'), 10)
    expect(folded.satisfied).toBe(true)
    expect(folded.approvals).toEqual([{ actorId: 'usr_1', actorLabel: 'usr_1', at: 10 }])
  })

  it('counts DISTINCT identities, so one person clicking twice cannot clear a two-person gate', () => {
    const first = foldGateApproval({ requiredApprovals: 2 }, user('usr_1'), 10)
    expect(first.satisfied).toBe(false)
    const again = foldGateApproval(
      { requiredApprovals: 2, approvals: first.approvals },
      user('usr_1'),
      20,
    )
    expect(again.satisfied).toBe(false)
    // The re-approval REPLACES rather than appends, so the timestamp advances and the count does not.
    expect(again.approvals).toEqual([{ actorId: 'usr_1', actorLabel: 'usr_1', at: 20 }])

    const second = foldGateApproval(
      { requiredApprovals: 2, approvals: again.approvals },
      user('usr_2'),
      30,
    )
    expect(second.satisfied).toBe(true)
    expect(second.approvals.map((a) => a.actorId)).toEqual(['usr_1', 'usr_2'])
  })

  it('omits the label when the actor has none, rather than recording an empty one', () => {
    const folded = foldGateApproval({}, { id: 'pak_1', kind: 'api-key', role: null }, 5)
    expect(folded.approvals).toEqual([{ actorId: 'pak_1', at: 5 }])
    expect(folded.satisfied).toBe(true)
  })
})
