import { afterEach, describe, expect, it } from 'vitest'
import {
  isPresetFieldVisible,
  isSafeRepoDirPath,
  parseInitiativePresetDescriptor,
  validateInitiativePresetInputs,
  type InitiativePresetDescriptor,
  type InitiativePresetField,
} from '@cat-factory/contracts'
import {
  GENERIC_INITIATIVE_PRESET_ID,
  allInitiativePresets,
  clearRegisteredInitiativePresets,
  getInitiativePreset,
  initiativePresetDescriptors,
  registerInitiativePreset,
  type InitiativePresetRegistration,
} from './initiative-preset-registry.js'

const field = (over: Partial<InitiativePresetField> & { key: string }): InitiativePresetField => ({
  label: over.key,
  ...over,
})

const descriptor = (
  over: Partial<InitiativePresetDescriptor> = {},
): InitiativePresetDescriptor => ({
  id: 'preset_test',
  presentation: { label: 'Test', icon: 'i-lucide-x', color: '#000', description: 'A test preset.' },
  fields: [],
  planningPipelineId: 'pl_test',
  interview: 'skip',
  humanReviewDefault: false,
  defaultFragmentIds: [],
  ...over,
})

afterEach(() => clearRegisteredInitiativePresets())

describe('initiative preset registry', () => {
  it('resolves the built-in generic preset with an empty registry', () => {
    const generic = getInitiativePreset(GENERIC_INITIATIVE_PRESET_ID)
    expect(generic?.descriptor.planningPipelineId).toBe('pl_initiative')
    expect(generic?.descriptor.interview).toBe('full')
    expect(generic?.descriptor.humanReviewDefault).toBe(true)
    expect(getInitiativePreset('nope')).toBeUndefined()
  })

  it('lists the generic preset first, then registered ones in registration order', () => {
    registerInitiativePreset({ descriptor: descriptor({ id: 'preset_a' }) })
    registerInitiativePreset({ descriptor: descriptor({ id: 'preset_b' }) })
    expect(allInitiativePresets().map((p) => p.descriptor.id)).toEqual([
      GENERIC_INITIATIVE_PRESET_ID,
      'preset_a',
      'preset_b',
    ])
  })

  it('replaces a preset registered under the same id, and can override the generic one', () => {
    registerInitiativePreset({
      descriptor: descriptor({ id: 'preset_a', planningPipelineId: 'pl_one' }),
    })
    registerInitiativePreset({
      descriptor: descriptor({ id: 'preset_a', planningPipelineId: 'pl_two' }),
    })
    expect(getInitiativePreset('preset_a')?.descriptor.planningPipelineId).toBe('pl_two')

    registerInitiativePreset({ descriptor: descriptor({ id: GENERIC_INITIATIVE_PRESET_ID }) })
    expect(getInitiativePreset(GENERIC_INITIATIVE_PRESET_ID)?.descriptor.interview).toBe('skip')
    // Overriding the generic id means the built-in default is no longer PREPENDED — the
    // override appears in registration order (after the earlier preset_a) instead.
    expect(allInitiativePresets().map((p) => p.descriptor.id)).toEqual([
      'preset_a',
      GENERIC_INITIATIVE_PRESET_ID,
    ])
  })

  it('derives the wire `probe` flag from the presence of a `detect` hook', () => {
    const withDetect: InitiativePresetRegistration = {
      descriptor: descriptor({ id: 'preset_probe' }),
      detect: async () => ({}),
    }
    registerInitiativePreset(withDetect)
    registerInitiativePreset({ descriptor: descriptor({ id: 'preset_noprobe' }) })
    const byId = new Map(initiativePresetDescriptors().map((d) => [d.id, d]))
    expect(byId.get('preset_probe')?.probe).toBe(true)
    expect(byId.get('preset_noprobe')?.probe).toBe(false)
  })
})

describe('phaseTemplate on the descriptor', () => {
  const withTemplate = (template: unknown): unknown => ({
    ...descriptor({ id: 'preset_migration' }),
    phaseTemplate: template,
  })

  it('parses a well-formed template, preserving id/title/order and defaulting goal to ""', () => {
    const parsed = parseInitiativePresetDescriptor(
      withTemplate({
        phases: [
          { id: 'blast-zone', title: 'Blast zone', goal: 'Enumerate touchpoints.', required: true },
          { id: 'coverage', title: 'Coverage hardening', required: true },
        ],
        allowAdditionalPhases: false,
      }),
    )
    expect(parsed.phaseTemplate?.phases.map((p) => p.id)).toEqual(['blast-zone', 'coverage'])
    expect(parsed.phaseTemplate?.phases[0]?.goal).toBe('Enumerate touchpoints.')
    // Omitted `goal` clamps to '' exactly like the plan's own phase schema.
    expect(parsed.phaseTemplate?.phases[1]?.goal).toBe('')
    expect(parsed.phaseTemplate?.allowAdditionalPhases).toBe(false)
  })

  it('treats an absent phaseTemplate as free-form (the generic preset)', () => {
    expect(parseInitiativePresetDescriptor(descriptor()).phaseTemplate).toBeUndefined()
  })

  it('rejects duplicate phase ids (the ingest normalizer matches by id)', () => {
    expect(() =>
      parseInitiativePresetDescriptor(
        withTemplate({
          phases: [
            { id: 'dup', title: 'One' },
            { id: 'dup', title: 'Two' },
          ],
        }),
      ),
    ).toThrow()
  })

  it('rejects an empty phases array', () => {
    expect(() => parseInitiativePresetDescriptor(withTemplate({ phases: [] }))).toThrow()
  })
})

describe('isSafeRepoDirPath', () => {
  it('accepts repo-relative directories', () => {
    expect(isSafeRepoDirPath('docs')).toBe(true)
    expect(isSafeRepoDirPath('docs/diagrams')).toBe(true)
    expect(isSafeRepoDirPath('docs/')).toBe(true)
  })
  it('rejects escaping / absolute / malformed paths', () => {
    expect(isSafeRepoDirPath('../secrets')).toBe(false)
    expect(isSafeRepoDirPath('/etc')).toBe(false)
    expect(isSafeRepoDirPath('C:/win')).toBe(false)
    expect(isSafeRepoDirPath('docs\\win')).toBe(false)
    expect(isSafeRepoDirPath('   ')).toBe(false)
    expect(isSafeRepoDirPath('')).toBe(false)
  })
})

describe('isPresetFieldVisible', () => {
  const incField = field({
    key: 'diagramsDir',
    showWhen: { key: 'docTypes', includes: 'diagrams' },
  })
  it('shows a field with no condition', () => {
    expect(isPresetFieldVisible(field({ key: 'x' }), {})).toBe(true)
  })
  it('honours an `includes` condition against a checkbox-group value', () => {
    expect(isPresetFieldVisible(incField, { docTypes: ['readme', 'diagrams'] })).toBe(true)
    expect(isPresetFieldVisible(incField, { docTypes: ['readme'] })).toBe(false)
    expect(isPresetFieldVisible(incField, {})).toBe(false)
  })
  it('honours an `equals` condition against a scalar value', () => {
    const eqField = field({ key: 'docsRoot', showWhen: { key: 'placementMode', equals: 'root' } })
    expect(isPresetFieldVisible(eqField, { placementMode: 'root' })).toBe(true)
    expect(isPresetFieldVisible(eqField, { placementMode: 'per-service' })).toBe(false)
  })
  it('honours an `equals` condition against a checkbox (boolean) value', () => {
    const boolField = field({ key: 'advancedDir', showWhen: { key: 'advanced', equals: true } })
    expect(isPresetFieldVisible(boolField, { advanced: true })).toBe(true)
    expect(isPresetFieldVisible(boolField, { advanced: false })).toBe(false)
    expect(isPresetFieldVisible(boolField, {})).toBe(false)
  })
  it('treats an absent value as `false` for a boolean `equals: false` (unchecked box is unset)', () => {
    const offField = field({ key: 'simpleDir', showWhen: { key: 'advanced', equals: false } })
    // An off checkbox is absent from the inputs, so `equals: false` must still match at first render.
    expect(isPresetFieldVisible(offField, {})).toBe(true)
    expect(isPresetFieldVisible(offField, { advanced: false })).toBe(true)
    expect(isPresetFieldVisible(offField, { advanced: true })).toBe(false)
  })
})

describe('validateInitiativePresetInputs', () => {
  const desc = descriptor({
    fields: [
      field({ key: 'docsRoot', type: 'path', required: true }),
      field({
        key: 'docTypes',
        type: 'checkbox-group',
        options: [
          { value: 'readme', label: 'READMEs' },
          { value: 'diagrams', label: 'Diagrams' },
        ],
      }),
      field({ key: 'placementMode', type: 'select', options: [{ value: 'root', label: 'Root' }] }),
      field({
        key: 'diagramsDir',
        type: 'path',
        showWhen: { key: 'docTypes', includes: 'diagrams' },
      }),
    ],
  })

  it('accepts a well-formed form', () => {
    expect(
      validateInitiativePresetInputs(desc, {
        docsRoot: 'docs',
        docTypes: ['readme', 'diagrams'],
        placementMode: 'root',
        diagramsDir: 'docs/diagrams',
      }),
    ).toEqual([])
  })

  it('flags an unknown key', () => {
    expect(validateInitiativePresetInputs(desc, { docsRoot: 'docs', bogus: 'x' })).toContainEqual(
      expect.stringContaining('Unknown field "bogus"'),
    )
  })

  it('requires a visible required field but not a hidden one', () => {
    expect(validateInitiativePresetInputs(desc, {})).toContainEqual(
      expect.stringContaining('Field "docsRoot" is required'),
    )
    // diagramsDir is hidden (docTypes lacks 'diagrams'), so it is never required.
    expect(
      validateInitiativePresetInputs(desc, { docsRoot: 'docs', docTypes: ['readme'] }),
    ).toEqual([])
  })

  it('rejects values outside a select / checkbox-group options and unsafe paths', () => {
    const problems = validateInitiativePresetInputs(desc, {
      docsRoot: '../escape',
      docTypes: ['readme', 'nope'],
      placementMode: 'invalid',
    })
    expect(problems).toContainEqual(expect.stringContaining('"docsRoot" must be a relative path'))
    expect(problems).toContainEqual(expect.stringContaining('"nope"'))
    expect(problems).toContainEqual(expect.stringContaining('"placementMode" has a value outside'))
  })

  it('rejects a value whose type mismatches the field', () => {
    expect(
      validateInitiativePresetInputs(desc, { docsRoot: 'docs', docTypes: 'not-an-array' }),
    ).toContainEqual(expect.stringContaining('wrong type'))
  })

  it('treats an unchecked required checkbox as unset', () => {
    const withConsent = descriptor({
      fields: [field({ key: 'consent', type: 'checkbox', required: true })],
    })
    // Unchecked (`false`) fails the required check; checked (`true`) passes.
    expect(validateInitiativePresetInputs(withConsent, { consent: false })).toContainEqual(
      expect.stringContaining('Field "consent" is required'),
    )
    expect(validateInitiativePresetInputs(withConsent, { consent: true })).toEqual([])
  })
})
