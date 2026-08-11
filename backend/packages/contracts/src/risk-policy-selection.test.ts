import { describe, expect, it } from 'vitest'
import {
  refuseRiskPolicySelection,
  UNATTRIBUTED_BLOCK_EDITOR,
  type BlockEditActor,
  type RolePolicyView,
} from './risk-policy-selection.js'

/** A preset's role layer, defaulting to the identity every built-in ships with. */
const policy = (over: Partial<RolePolicyView> = {}): RolePolicyView => ({
  classRules: {},
  classRulesByRole: {},
  dryRunRoles: [],
  submissionClassesByRole: {},
  ...over,
})

const member: BlockEditActor = { role: 'member', managesPolicy: false }
const admin: BlockEditActor = { role: 'admin', managesPolicy: true }
/** An admin who does NOT own the preset library, so the rule still has something to decide. */
const admin2: BlockEditActor = { role: 'admin', managesPolicy: false }
const viewer: BlockEditActor = { role: 'viewer', managesPolicy: false }

/**
 * The SAME-workspace swap, which is what the picker and a `riskPolicyId` patch make: one library,
 * so one actor answers for both sides. The two-sided cases at the bottom are the cross-home move,
 * where the editor is a different person to each workspace.
 */
const judge = (input: { from: RolePolicyView; to: RolePolicyView; actor: BlockEditActor }) =>
  refuseRiskPolicySelection({
    from: { policy: input.from, actor: input.actor },
    to: { policy: input.to, actor: input.actor },
  })

describe('refuseRiskPolicySelection: the oversight arm', () => {
  it('refuses a swap onto an unattended preset, the one every workspace now seeds', () => {
    // The escape hatch this arm closes, and the reason the other three miss it: `mp_unattended`
    // ships with an EMPTY role layer, byte-for-byte identical to `mp_balanced`'s, so the sandbox,
    // allowlist and class-rule tests all pass it. What it changes is that the run answers the
    // parks its own loops raise, which is a member-tier board write away with no arm here.
    expect(
      judge({
        from: policy({ autonomy: 'attended' }),
        to: policy({ autonomy: 'unattended' }),
        actor: member,
      }),
    ).toBe('relaxes_run_oversight')
  })

  it('allows a swap INTO oversight, and one that keeps the posture either way', () => {
    // Narrow-only, like every other arm: adopting the policy that stops for a person needs no
    // permission, and two presets that agree relax nothing.
    expect(
      judge({
        from: policy({ autonomy: 'unattended' }),
        to: policy({ autonomy: 'attended' }),
        actor: member,
      }),
    ).toBeNull()
    expect(
      judge({
        from: policy({ autonomy: 'unattended' }),
        to: policy({ autonomy: 'unattended' }),
        actor: member,
      }),
    ).toBeNull()
    expect(
      judge({
        from: policy({ autonomy: 'attended' }),
        to: policy({ autonomy: 'attended' }),
        actor: member,
      }),
    ).toBeNull()
  })

  it('reads an absent or unrecognised posture as attended, in BOTH directions', () => {
    // The closed-vocabulary rule `resolvesOwnCaps` states: a row written under a member later
    // retired reads back as neither spelling, and not knowing what a policy says is not a licence
    // to drop a checkpoint. So an unknown value never relaxes, and never excuses a relaxation.
    const unknown = policy({ autonomy: 'sometimes' as never })
    expect(judge({ from: policy(), to: policy({ autonomy: 'unattended' }), actor: member })).toBe(
      'relaxes_run_oversight',
    )
    expect(judge({ from: unknown, to: policy({ autonomy: 'unattended' }), actor: member })).toBe(
      'relaxes_run_oversight',
    )
    expect(judge({ from: policy({ autonomy: 'attended' }), to: unknown, actor: member })).toBeNull()
  })

  it('yields to the library owner, like every other arm', () => {
    expect(
      judge({
        from: policy({ autonomy: 'attended' }),
        to: policy({ autonomy: 'unattended' }),
        actor: admin,
      }),
    ).toBeNull()
  })

  it('is named AHEAD of the merge-ladder arms when a swap relaxes both', () => {
    // Precedence matters because the refusal reaches a person as ONE reason. The parks this drops
    // are raised while the run is still working, before anything has a pull request to weigh, so
    // it is the one to name.
    expect(
      judge({
        from: policy({ autonomy: 'attended', dryRunRoles: ['member'] }),
        to: policy({ autonomy: 'unattended' }),
        actor: member,
      }),
    ).toBe('relaxes_run_oversight')
  })
})

describe('refuseRiskPolicySelection: the sandbox arm', () => {
  it('refuses a swap that drops the sandbox the selector was under', () => {
    // The escape hatch this rule exists to close: editing `dryRunRoles` is admin-gated, but
    // pointing the task at a preset that lists nobody is a member-tier board write.
    expect(
      judge({
        from: policy({ dryRunRoles: ['member'] }),
        to: policy(),
        actor: member,
      }),
    ).toBe('relaxes_role_sandbox')
  })

  it('allows a swap INTO a sandbox, and one that keeps it', () => {
    // Narrow-only cuts one way: adopting a stricter policy needs no permission at all.
    expect(
      judge({
        from: policy(),
        to: policy({ dryRunRoles: ['member'] }),
        actor: member,
      }),
    ).toBeNull()
    expect(
      judge({
        from: policy({ dryRunRoles: ['member'] }),
        to: policy({ dryRunRoles: ['member', 'viewer'] }),
        actor: member,
      }),
    ).toBeNull()
  })

  it('reads a sandbox on ANOTHER tier as no restriction on this one', () => {
    // A preset that sandboxes viewers says nothing about a member, so a member moving off it is
    // dropping nothing of their own.
    expect(
      judge({
        from: policy({ dryRunRoles: ['viewer'] }),
        to: policy(),
        actor: member,
      }),
    ).toBeNull()
  })
})

describe('refuseRiskPolicySelection: the class-rule arm', () => {
  it('refuses a swap that drops a class rule the ROLE layer narrowed', () => {
    expect(
      judge({
        from: policy({
          classRules: { source: 'always' },
          classRulesByRole: { member: { source: 'never' } },
        }),
        to: policy({ classRules: { source: 'always' } }),
        actor: member,
      }),
    ).toBe('relaxes_role_class_rule')
  })

  it('allows a swap that keeps the role at least as narrow, however it gets there', () => {
    // The target reaches `never` through its BASE map rather than a role entry. The selector is no
    // less restricted, so there is nothing to refuse. What matters is the effective rule, not
    // which layer of the preset produced it.
    expect(
      judge({
        from: policy({
          classRules: { source: 'always' },
          classRulesByRole: { member: { source: 'never' } },
        }),
        to: policy({ classRules: { source: 'never' } }),
        actor: member,
      }),
    ).toBeNull()
  })

  it('ignores a class whose rules differ only in the BASE map', () => {
    // The deliberate non-goal. `classRules` says the same thing to every tier, so moving a task
    // from a strict preset to a lax one is the ordinary per-task choice the library exists for;
    // refusing it here would make preset selection admin-only on deployments with no role policy.
    expect(
      judge({
        from: policy({ classRules: { source: 'never' } }),
        to: policy({ classRules: { source: 'always' } }),
        actor: member,
      }),
    ).toBeNull()
  })

  it('ignores a role entry that was inert on the source preset', () => {
    // `{ source: 'always' }` under a role, on a base already at `thresholds`, grants nothing and
    // narrows nothing (`narrowMergeClassRule`), so losing it costs the selector nothing either.
    expect(
      judge({
        from: policy({ classRulesByRole: { member: { source: 'always' } } }),
        to: policy({ classRules: { source: 'always' } }),
        actor: member,
      }),
    ).toBeNull()
  })

  it('refuses on ANY narrowed class, not only the first the preset authored', () => {
    expect(
      judge({
        from: policy({
          classRules: { docs: 'always', schema: 'always' },
          classRulesByRole: { member: { docs: 'never', schema: 'thresholds' } },
        }),
        // `docs` stays narrowed; `schema` is handed back the blanket auto-merge.
        to: policy({
          classRules: { docs: 'always', schema: 'always' },
          classRulesByRole: { member: { docs: 'never' } },
        }),
        actor: member,
      }),
    ).toBe('relaxes_role_class_rule')
  })
})

describe('refuseRiskPolicySelection: the submission-allowlist arm', () => {
  it('refuses a swap onto a preset that allowlists the role nothing at all', () => {
    // The same escape hatch as the sandbox arm, through the field ADR 0039 added: a member the
    // preset holds to docs cannot re-point the task at one that leaves them unrestricted.
    expect(
      judge({
        from: policy({ submissionClassesByRole: { member: ['docs'] } }),
        to: policy(),
        actor: member,
      }),
    ).toBe('relaxes_role_submission_allowlist')
  })

  it('refuses a swap that ADDS a class to the allowlist the selector was under', () => {
    expect(
      judge({
        from: policy({ submissionClassesByRole: { member: ['docs'] } }),
        to: policy({ submissionClassesByRole: { member: ['docs', 'source'] } }),
        actor: member,
      }),
    ).toBe('relaxes_role_submission_allowlist')
  })

  // The distinction the editor is a switch plus tick boxes to preserve: an EMPTY allowlist lands
  // nothing and an ABSENT one lands everything, so a swap between them is the widest relaxation
  // the setting can express, not a no-op between two falsy values.
  it('refuses moving off an EMPTY allowlist to an absent one', () => {
    expect(
      judge({
        from: policy({ submissionClassesByRole: { member: [] } }),
        to: policy(),
        actor: member,
      }),
    ).toBe('relaxes_role_submission_allowlist')
  })

  it('allows a swap that narrows the allowlist, or keeps it', () => {
    expect(
      judge({
        from: policy({ submissionClassesByRole: { member: ['docs', 'source'] } }),
        to: policy({ submissionClassesByRole: { member: ['docs'] } }),
        actor: member,
      }),
    ).toBeNull()
    expect(
      judge({
        from: policy({ submissionClassesByRole: { member: ['docs'] } }),
        to: policy({ submissionClassesByRole: { member: ['docs'] } }),
        actor: member,
      }),
    ).toBeNull()
  })

  it('allows a swap INTO an allowlist from an unrestricted preset', () => {
    // Narrow-only cuts one way here too: the selector was under no allowlist, so the move takes
    // capability away rather than granting it.
    expect(
      judge({
        from: policy(),
        to: policy({ submissionClassesByRole: { member: ['docs'] } }),
        actor: member,
      }),
    ).toBeNull()
  })

  it('reads an allowlist on ANOTHER tier as no restriction on this one', () => {
    expect(
      judge({
        from: policy({ submissionClassesByRole: { viewer: ['docs'] } }),
        to: policy(),
        actor: member,
      }),
    ).toBeNull()
  })

  it('names the allowlist ahead of a class rule the same swap also relaxes', () => {
    // The arms run in the engine's own precedence order, so a swap that drops both restrictions
    // reports the one that bars LANDING rather than the one that only demands review.
    expect(
      judge({
        from: policy({
          classRules: { source: 'always' },
          classRulesByRole: { member: { source: 'never' } },
          submissionClassesByRole: { member: ['docs'] },
        }),
        to: policy({ classRules: { source: 'always' } }),
        actor: member,
      }),
    ).toBe('relaxes_role_submission_allowlist')
  })
})

describe('refuseRiskPolicySelection: who it cannot refuse', () => {
  it('never refuses an editor who manages the policy library', () => {
    // An admin can delete `dryRunRoles` outright, so refusing them the swap protects nothing.
    expect(
      judge({
        from: policy({ dryRunRoles: ['admin'] }),
        to: policy(),
        actor: admin,
      }),
    ).toBeNull()
  })

  it('never refuses an editor with no workspace tier', () => {
    // No role means no role entry can match, so there is no restriction to drop: the same
    // reading an unattributed RUN gets, and the reason a board scan and an API key pass through.
    expect(
      judge({
        from: policy({ dryRunRoles: ['member', 'viewer', 'admin'] }),
        to: policy(),
        actor: UNATTRIBUTED_BLOCK_EDITOR,
      }),
    ).toBeNull()
  })

  it('is inert between two presets that treat every initiator alike', () => {
    // Every built-in ships with an empty role layer, so this is the common case: the guard cannot
    // refuse anything until an operator authors a role policy.
    expect(
      judge({
        from: policy({ classRules: { docs: 'never' } }),
        to: policy({ classRules: { dependency: 'always' } }),
        actor: member,
      }),
    ).toBeNull()
  })
})

describe('refuseRiskPolicySelection: two workspaces, two authorities', () => {
  // The cross-home move. The two policies come from two libraries, and so do the two roles: a
  // preset's role layer is a statement about roles in the workspace holding it, so reading the
  // destination's layer against the role the mover holds at the SOURCE answers nothing anyone
  // asked. Judging both sides against one pre-resolved actor is what these cases pin shut.

  it('judges each side against the role the editor holds THERE', () => {
    // Sandboxed as a member at the source, an admin at the destination where only viewers are.
    // The restriction was real and the move drops it.
    expect(
      refuseRiskPolicySelection({
        from: { policy: policy({ dryRunRoles: ['member'] }), actor: member },
        to: { policy: policy({ dryRunRoles: ['viewer'] }), actor: admin2 },
      }),
    ).toBe('relaxes_role_sandbox')
    // The mirror: the destination sandboxes the tier the editor holds THERE, so nothing is
    // dropped, even though its layer says nothing about their source tier. Reading the
    // destination against the source role would have called this an escape.
    expect(
      refuseRiskPolicySelection({
        from: { policy: policy({ dryRunRoles: ['member'] }), actor: member },
        to: { policy: policy({ dryRunRoles: ['admin'] }), actor: admin2 },
      }),
    ).toBeNull()
  })

  it('passes when the editor holds no tier at the DESTINATION', () => {
    // They cannot admit a run in a workspace they are not a member of, so its policy holds
    // nothing of theirs to drop. Absent is the strictest reading here, not the weakest: read the
    // other way, moving a task into a service you are not a member of refuses with a sandbox
    // nobody would have escaped.
    expect(
      refuseRiskPolicySelection({
        from: { policy: policy({ dryRunRoles: ['member'] }), actor: member },
        to: { policy: policy(), actor: UNATTRIBUTED_BLOCK_EDITOR },
      }),
    ).toBeNull()
  })

  it('passes when the editor holds no tier at the SOURCE', () => {
    // Nothing held them there, so the move relaxes nothing. What they can do at the destination
    // is their membership of it, which the move did not grant.
    expect(
      refuseRiskPolicySelection({
        from: { policy: policy({ dryRunRoles: ['member'] }), actor: UNATTRIBUTED_BLOCK_EDITOR },
        to: { policy: policy(), actor: member },
      }),
    ).toBeNull()
  })

  it('stands down when the editor manages the library on EITHER side', () => {
    // Owning either library means authoring the outcome outright, so refusing the move is
    // theatre with a support ticket attached. Both directions, because the source library is as
    // editable as the destination one.
    const manager: BlockEditActor = { role: 'member', managesPolicy: true }
    expect(
      refuseRiskPolicySelection({
        from: { policy: policy({ dryRunRoles: ['member'] }), actor: manager },
        to: { policy: policy(), actor: member },
      }),
    ).toBeNull()
    expect(
      refuseRiskPolicySelection({
        from: { policy: policy({ dryRunRoles: ['member'] }), actor: member },
        to: { policy: policy(), actor: manager },
      }),
    ).toBeNull()
  })

  it('refuses an allowlist the destination widens for the DESTINATION role', () => {
    // Held to docs-only as a member at the source; a viewer at the destination, where viewers
    // may also land dependency changes. The widening is only visible when each allowlist is read
    // against its own side's role.
    expect(
      refuseRiskPolicySelection({
        from: { policy: policy({ submissionClassesByRole: { member: ['docs'] } }), actor: member },
        to: {
          policy: policy({ submissionClassesByRole: { viewer: ['docs', 'dependency'] } }),
          actor: viewer,
        },
      }),
    ).toBe('relaxes_role_submission_allowlist')
  })
})
