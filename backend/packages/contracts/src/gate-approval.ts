import type { GateApprovalRecord, GateApproverPolicy, StepGateConfig } from './gate-config.js'
import type { StepApproval } from './step-decisions.js'
import type { WorkspaceRole } from './workspace-members.js'

// ---------------------------------------------------------------------------
// The pure decision logic behind a per-step human approval gate: who may resolve it, and when
// enough people have.
//
// In CONTRACTS rather than kernel because the SPA has to agree about the answer, not just consume
// it: the approve button is disabled for someone the policy does not admit, and the gate renders
// "1 of 2 approvals" from the same rule the engine enforces. A rule the SPA cannot import is a
// rule the SPA reimplements, and the two then drift into a button that is enabled for a request
// the server refuses.
//
// Everything stateful stays in the engine: raising the gate, persisting it under CAS, waking the
// durable driver. Nothing here reads or writes anything.
// ---------------------------------------------------------------------------

/** The identity resolving a gate, as each entry point already knows it. */
export interface GateActor {
  /**
   * Stable id of the acting identity: a `usr_*` id for a signed-in person, the public-API key id
   * for an integration, or `UNATTRIBUTED_GATE_ACTOR` (see `gate-config.ts`) when the deployment
   * runs with auth disabled and there is nobody to attribute the action to.
   */
  id: string
  /** What kind of identity it is, which is what decides whether a NAMED approver policy admits it. */
  kind: 'user' | 'api-key' | 'unattributed'
  /**
   * The actor's workspace role, as the auth gate already resolved it. `null` on a machine key
   * and under dev-open — a real state, not a missing one, and never read as the lowest tier.
   */
  role: WorkspaceRole | null
  /** Display label snapshotted onto the recorded approval (login/name, or the key's label). */
  label?: string
}

/** Why an actor may not resolve a gate — the machine-readable half of the refusal. */
export type GateApprovalRefusal = 'not_a_gate_approver' | 'gate_approver_identity_required'

/**
 * Whether a gate configures an approver policy at all. An empty policy object (`{}`, or one whose
 * two arrays are both empty) is NOT a policy: it names nobody, so treating it as one would refuse
 * every actor and park the run forever. The builder never writes one, but a hand-authored pipeline
 * or an API caller can.
 */
export function hasApproverPolicy(policy: GateApproverPolicy | undefined): boolean {
  return (policy?.roles?.length ?? 0) > 0 || (policy?.userIds?.length ?? 0) > 0
}

/**
 * Whether `actor` may resolve a gate carrying `policy` (approve, request changes, or reject —
 * all three are resolutions, and a policy that let a non-approver reject would gate nothing).
 *
 * Returns `null` when permitted, or the reason it is refused:
 *
 *  - With no policy, everyone the workspace RBAC gate already admitted is permitted. That gate
 *    enforces the viewer write floor before this is consulted, so "no policy" means "member and
 *    above", exactly as it did before gate config existed.
 *  - A workspace `admin` is always permitted. An admin can cancel the run or edit the pipeline,
 *    so refusing them buys nothing and would deadlock a gate whose named approvers have left.
 *  - Otherwise the actor qualifies by holding a listed role or by being a listed user.
 *  - A machine key or an unattributed caller is refused by ANY policy: a shared credential is not
 *    one of the people a policy named, and the honest answer is that this gate needs a person.
 */
export function refuseGateResolution(
  policy: GateApproverPolicy | undefined,
  actor: GateActor,
): GateApprovalRefusal | null {
  if (!hasApproverPolicy(policy)) return null
  if (actor.kind !== 'user') return 'gate_approver_identity_required'
  if (actor.role === 'admin') return null
  if (actor.role && policy?.roles?.includes(actor.role)) return null
  if (policy?.userIds?.includes(actor.id)) return null
  return 'not_a_gate_approver'
}

/**
 * How many approvals a gate needs, from its config. Absent / below 1 ⇒ 1, so an unconfigured gate
 * (and a hand-authored `minApprovals: 0`, which would otherwise mean "advance with nobody") keeps
 * the single-approval behaviour.
 */
export function requiredGateApprovals(config: StepGateConfig | undefined): number {
  const min = config?.minApprovals
  return typeof min === 'number' && min > 1 ? Math.floor(min) : 1
}

/**
 * Fold one actor's approval into the gate's recorded list, returning the new list and whether the
 * quorum is now met.
 *
 * Idempotent per identity: a second approval from the same actor REPLACES the first (refreshing
 * its timestamp and label) rather than counting twice, so a double-click cannot satisfy a
 * two-person gate. That is also why the quorum counts entries in this list rather than a
 * bare counter — a counter cannot tell one person clicking twice from two people.
 */
export function foldGateApproval(
  approval: Pick<StepApproval, 'approvals' | 'requiredApprovals'>,
  actor: GateActor,
  at: number,
): { approvals: GateApprovalRecord[]; satisfied: boolean } {
  const record: GateApprovalRecord = {
    actorId: actor.id,
    ...(actor.label ? { actorLabel: actor.label } : {}),
    at,
  }
  const existing = approval.approvals ?? []
  const approvals = [...existing.filter((a) => a.actorId !== actor.id), record]
  const required = approval.requiredApprovals ?? 1
  return { approvals, satisfied: approvals.length >= required }
}
