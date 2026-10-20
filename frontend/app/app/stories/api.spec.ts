import { deleteModelPresetContract, listModelPresetsContract } from '@cat-factory/contracts'
import { describe, expect, it } from 'vitest'
import { apiPending } from './api'

describe('apiPending', () => {
  it('refuses a contract with no JSON success body, whose answer would not stay pending', () => {
    expect(() =>
      apiPending(deleteModelPresetContract, { pathParams: { presetId: 'mdp_story' } }),
    ).toThrow(/No 200 or 201 JSON schema/)
  })

  it('takes a contract with a JSON success body', () => {
    expect(() => apiPending(listModelPresetsContract)).not.toThrow()
  })
})
