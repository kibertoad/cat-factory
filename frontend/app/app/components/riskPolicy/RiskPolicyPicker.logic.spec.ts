import { describe, expect, it } from 'vitest'
import type { RiskPolicy } from '~/types/merge'
import { resolveRiskPolicyPicker } from '~/components/riskPolicy/RiskPolicyPicker.logic'

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
