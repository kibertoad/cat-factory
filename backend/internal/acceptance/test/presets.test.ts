import { describe, expect, it } from 'vitest'
import { needsPersonalPassword, pinnedModel } from '../src/presets.ts'

// The join `configure`, the `model-preset` gate and now the up-front unlock all read. What is pinned
// here is only the part the unlock depends on: whether a pass on the pinned preset is going to be
// asked for a personal password, BEFORE anything has been dispatched to find out.

const preset = (presetId: string, baseModelId: string) => ({
  presetId,
  name: `preset ${presetId}`,
  baseModelId,
})

const model = (modelId: string, overrides: Record<string, unknown> = {}) => ({
  modelId,
  label: `label of ${modelId}`,
  provider: 'claude',
  available: true,
  policyBlocked: false,
  personalSubscription: false,
  subscriptionConfigured: null,
  ...overrides,
})

describe('pinnedModel', () => {
  it('resolves the preset and the catalog row its base model names', () => {
    const found = pinnedModel([preset('mdp_1', 'claude-opus-5')], [model('claude-opus-5')], 'mdp_1')
    expect(found?.preset.presetId).toBe('mdp_1')
    expect(found?.model.modelId).toBe('claude-opus-5')
    // Generic in both rows, so the caller keeps what this join does not read: the up-front prompt
    // names the model and its provider to the operator, and re-finding the row to get them would be
    // two answers to one lookup.
    expect(found?.model.label).toBe('label of claude-opus-5')
    expect(found?.model.provider).toBe('claude')
  })

  it('answers null for a preset the library does not carry', () => {
    expect(pinnedModel([preset('mdp_1', 'm')], [model('m')], 'mdp_other')).toBeNull()
  })

  it('answers null for a preset whose base model the catalog does not carry', () => {
    // The preset outlived its model. `model-preset` reports that with the catalog listed; here it is
    // only "cannot tell", which is what keeps this hook from diagnosing what a scenario diagnoses better.
    expect(pinnedModel([preset('mdp_1', 'gone')], [model('m')], 'mdp_1')).toBeNull()
  })
})

describe('needsPersonalPassword', () => {
  it('reads `personalSubscription`, NOT `available`', () => {
    // The case that produced the up-front ask: the catalog reports the model dispatchable for this
    // token AND the dispatch answers 428, because what opens the credential is the password. Keyed
    // on `available` this would ask for nothing in exactly the pass that needs it.
    expect(
      needsPersonalPassword(
        model('claude-opus-5', { available: true, personalSubscription: true }),
      ),
    ).toBe(true)
  })

  it('needs one for a personal-subscription model this token cannot yet select', () => {
    expect(
      needsPersonalPassword(
        model('m', { available: false, personalSubscription: true, subscriptionConfigured: true }),
      ),
    ).toBe(true)
  })

  it('needs none for a model wired to a provider key', () => {
    expect(needsPersonalPassword(model('m'))).toBe(false)
  })

  // "Nothing to read" is deliberately NOT a third answer here: a catalog that could not be read and
  // a model that needs no password are opposite facts, and the one that carries the distinction is
  // the absence of a row at all (`pinnedModel` → null, above), decided where it is produced. Stated
  // as a third value it was decided twice, and the second decision was an unreachable guard.
})
