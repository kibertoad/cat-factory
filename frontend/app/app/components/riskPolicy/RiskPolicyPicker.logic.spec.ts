import { describe, expect, it } from 'vitest'
import type { RiskPolicy } from '~/types/merge'
import {
  refusedRiskPolicySelections,
  resolveRiskPolicyPicker,
} from '~/components/riskPolicy/RiskPolicyPicker.logic'

// The resolver reads ids only, so the fixture carries just enough to be identifiable.
const policy = (id: string, name: string) => ({ id, name }) as unknown as RiskPolicy

const balanced = policy('mp_balanced', 'Balanced')
const strict = policy('mp_strict', 'Strict')
const options = [balanced, strict]

describe('resolveRiskPolicyPicker', () => {
  it('previews the active row over the selection', () => {
    const state = resolveRiskPolicyPicker({
      options,
      defaultPolicy: balanced,
      modelValue: 'mp_balanced',
      activeId: 'mp_strict',
    })
    expect(state).toEqual({ policy: strict, viaWorkspaceDefault: false })
  })

  it('falls back to the selection when no row is active', () => {
    const state = resolveRiskPolicyPicker({
      options,
      defaultPolicy: balanced,
      modelValue: 'mp_strict',
      activeId: undefined,
    })
    expect(state).toEqual({ policy: strict, viaWorkspaceDefault: false })
  })

  it('previews the workspace default for the "pick nothing" row, captioned', () => {
    const state = resolveRiskPolicyPicker({
      options,
      defaultPolicy: balanced,
      modelValue: 'mp_strict',
      activeId: '',
    })
    expect(state).toEqual({ policy: balanced, viaWorkspaceDefault: true })
  })

  it('previews the workspace default when nothing is selected at all', () => {
    const state = resolveRiskPolicyPicker({
      options,
      defaultPolicy: balanced,
      modelValue: '',
      activeId: undefined,
    })
    expect(state).toEqual({ policy: balanced, viaWorkspaceDefault: true })
  })

  it('resolves a DELETED policy to the workspace default, as the run engine does', () => {
    // A task can hold a riskPolicyId whose policy was since removed from the library. The
    // store's resolve() hands that task the default, so the pane must not claim there is no
    // policy — that would describe the run wrongly on the one surface explaining it.
    const state = resolveRiskPolicyPicker({
      options,
      defaultPolicy: balanced,
      modelValue: 'mp_deleted',
      activeId: undefined,
    })
    expect(state).toEqual({ policy: balanced, viaWorkspaceDefault: true })
  })

  it('reports nothing to preview only when the workspace has no default at all', () => {
    const state = resolveRiskPolicyPicker({
      options: [],
      defaultPolicy: null,
      modelValue: '',
      activeId: '',
    })
    expect(state).toEqual({ policy: null, viaWorkspaceDefault: false })
  })
})

describe('refusedRiskPolicySelections', () => {
  const rolePolicy = (id: string, over: Partial<RiskPolicy>) =>
    ({ id, name: id, classRules: {}, classRulesByRole: {}, dryRunRoles: [], ...over }) as RiskPolicy

  const sandboxed = rolePolicy('mp_sandboxed', { dryRunRoles: ['member'] })
  const open = rolePolicy('mp_open', {})
  const member = { role: 'member' as const, managesPolicy: false }

  it('marks the rows a member may not move a sandboxed task to', () => {
    // The picker must not offer what the backend refuses, including the "workspace default" row,
    // which is a real policy (here: the open one) and not the absence of a choice.
    const refused = refusedRiskPolicySelections({
      options: [sandboxed, open],
      defaultPolicy: open,
      modelValue: 'mp_sandboxed',
      actor: member,
    })
    expect(refused.get('mp_open')).toBe('relaxes_role_sandbox')
    expect(refused.get('')).toBe('relaxes_role_sandbox')
    expect(refused.has('mp_sandboxed')).toBe(false) // the row already selected
  })

  it('judges a task that picked nothing against the workspace default, as the engine does', () => {
    // The create-form shape: nothing selected yet, so the policy being moved AWAY from is the one
    // the task would have been governed by.
    const refused = refusedRiskPolicySelections({
      options: [sandboxed, open],
      defaultPolicy: sandboxed,
      modelValue: '',
      actor: member,
    })
    expect(refused.get('mp_open')).toBe('relaxes_role_sandbox')
    expect(refused.has('mp_sandboxed')).toBe(false)
  })

  it('refuses nothing to an editor who manages the policy library', () => {
    const refused = refusedRiskPolicySelections({
      options: [sandboxed, open],
      defaultPolicy: open,
      modelValue: 'mp_sandboxed',
      actor: { role: 'admin', managesPolicy: true },
    })
    expect(refused.size).toBe(0)
  })

  it('refuses nothing between policies that treat every initiator alike', () => {
    // Every built-in ships with an empty role layer, so the common case offers the whole library.
    const refused = refusedRiskPolicySelections({
      options: [open, rolePolicy('mp_other', {})],
      defaultPolicy: open,
      modelValue: 'mp_open',
      actor: member,
    })
    expect(refused.size).toBe(0)
  })
})
