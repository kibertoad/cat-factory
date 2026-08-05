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

describe('refuseRiskPolicySelection: the sandbox arm', () => {
  it('refuses a swap that drops the sandbox the selector was under', () => {
    // The escape hatch this rule exists to close: editing `dryRunRoles` is admin-gated, but
    // pointing the task at a preset that lists nobody is a member-tier board write.
    expect(
      refuseRiskPolicySelection({
        from: policy({ dryRunRoles: ['member'] }),
        to: policy(),
        actor: member,
      }),
    ).toBe('relaxes_role_sandbox')
  })

  it('allows a swap INTO a sandbox, and one that keeps it', () => {
    // Narrow-only cuts one way: adopting a stricter policy needs no permission at all.
    expect(
      refuseRiskPolicySelection({
        from: policy(),
        to: policy({ dryRunRoles: ['member'] }),
        actor: member,
      }),
    ).toBeNull()
    expect(
      refuseRiskPolicySelection({
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
      refuseRiskPolicySelection({
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
      refuseRiskPolicySelection({
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
      refuseRiskPolicySelection({
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
      refuseRiskPolicySelection({
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
      refuseRiskPolicySelection({
        from: policy({ classRulesByRole: { member: { source: 'always' } } }),
        to: policy({ classRules: { source: 'always' } }),
        actor: member,
      }),
    ).toBeNull()
  })

  it('refuses on ANY narrowed class, not only the first the preset authored', () => {
    expect(
      refuseRiskPolicySelection({
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
      refuseRiskPolicySelection({
        from: policy({ submissionClassesByRole: { member: ['docs'] } }),
        to: policy(),
        actor: member,
      }),
    ).toBe('relaxes_role_submission_allowlist')
  })

  it('refuses a swap that ADDS a class to the allowlist the selector was under', () => {
    expect(
      refuseRiskPolicySelection({
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
      refuseRiskPolicySelection({
        from: policy({ submissionClassesByRole: { member: [] } }),
        to: policy(),
        actor: member,
      }),
    ).toBe('relaxes_role_submission_allowlist')
  })

  it('allows a swap that narrows the allowlist, or keeps it', () => {
    expect(
      refuseRiskPolicySelection({
        from: policy({ submissionClassesByRole: { member: ['docs', 'source'] } }),
        to: policy({ submissionClassesByRole: { member: ['docs'] } }),
        actor: member,
      }),
    ).toBeNull()
    expect(
      refuseRiskPolicySelection({
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
      refuseRiskPolicySelection({
        from: policy(),
        to: policy({ submissionClassesByRole: { member: ['docs'] } }),
        actor: member,
      }),
    ).toBeNull()
  })

  it('reads an allowlist on ANOTHER tier as no restriction on this one', () => {
    expect(
      refuseRiskPolicySelection({
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
      refuseRiskPolicySelection({
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
      refuseRiskPolicySelection({
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
      refuseRiskPolicySelection({
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
      refuseRiskPolicySelection({
        from: policy({ classRules: { docs: 'never' } }),
        to: policy({ classRules: { dependency: 'always' } }),
        actor: member,
      }),
    ).toBeNull()
  })
})
