import { describe, expect, it } from 'vitest'
import type { InitiativePresetDescriptor, InitiativePresetField } from './initiative-preset.js'
import {
  isPresetFieldVisible,
  isSafeRepoDirPath,
  renderInitiativePresetValue,
  sanitizeInitiativePresetInputs,
  validateInitiativePresetInputs,
} from './initiative-preset.js'

// isSafeRepoDirPath is the `path`-field write-boundary guard (the directory writers commit
// under). Same traversal/absolute/backslash rejection as isSafeDocPath, minus the .md rule.
describe('isSafeRepoDirPath', () => {
  it('accepts relative dirs, with a tolerated trailing slash', () => {
    expect(isSafeRepoDirPath('docs')).toBe(true)
    expect(isSafeRepoDirPath('docs/rfcs')).toBe(true)
    expect(isSafeRepoDirPath('docs/rfcs/')).toBe(true)
  })

  it('rejects empty, traversal, absolute, backslash and NUL', () => {
    expect(isSafeRepoDirPath('')).toBe(false)
    expect(isSafeRepoDirPath('   ')).toBe(false)
    expect(isSafeRepoDirPath('../x')).toBe(false)
    expect(isSafeRepoDirPath('a/../../b')).toBe(false)
    expect(isSafeRepoDirPath('/abs')).toBe(false)
    expect(isSafeRepoDirPath('C:/x')).toBe(false)
    expect(isSafeRepoDirPath('a\\b')).toBe(false)
    expect(isSafeRepoDirPath('a\0b')).toBe(false)
  })

  it('rejects paths longer than 300 chars', () => {
    expect(isSafeRepoDirPath('a/'.repeat(200))).toBe(false)
  })
})

function field(
  over: Partial<InitiativePresetField> & Pick<InitiativePresetField, 'key'>,
): InitiativePresetField {
  return { label: over.key, ...over }
}

describe('isPresetFieldVisible', () => {
  it('is always visible without a showWhen condition', () => {
    expect(isPresetFieldVisible(field({ key: 'a' }), {})).toBe(true)
  })

  it('gates on scalar equality', () => {
    const f = field({ key: 'child', showWhen: { key: 'mode', equals: 'advanced' } })
    expect(isPresetFieldVisible(f, { mode: 'advanced' })).toBe(true)
    expect(isPresetFieldVisible(f, { mode: 'basic' })).toBe(false)
    expect(isPresetFieldVisible(f, {})).toBe(false)
  })

  it('treats an absent value as false when comparing against a boolean (unchecked checkbox)', () => {
    // The documented edge case: an off checkbox is ABSENT from inputs, so `equals: false`
    // must still match at initial render rather than only after a toggle on->off.
    const f = field({ key: 'child', showWhen: { key: 'flag', equals: false } })
    expect(isPresetFieldVisible(f, {})).toBe(true)
    expect(isPresetFieldVisible(f, { flag: false })).toBe(true)
    expect(isPresetFieldVisible(f, { flag: true })).toBe(false)
  })

  it('gates on checkbox-group membership via includes', () => {
    const f = field({ key: 'child', showWhen: { key: 'docTypes', includes: 'diagrams' } })
    expect(isPresetFieldVisible(f, { docTypes: ['prd', 'diagrams'] })).toBe(true)
    expect(isPresetFieldVisible(f, { docTypes: ['prd'] })).toBe(false)
    expect(isPresetFieldVisible(f, { docTypes: 'diagrams' })).toBe(false)
    expect(isPresetFieldVisible(f, {})).toBe(false)
  })
})

function descriptor(fields: InitiativePresetField[]): InitiativePresetDescriptor {
  return {
    id: 'preset_test',
    presentation: { label: 'Test', icon: 'i-lucide-x', color: '#000', description: '' },
    fields,
    planningPipelineId: 'pl_test',
    interview: 'skip',
    humanReviewDefault: false,
    defaultFragmentIds: [],
  }
}

describe('validateInitiativePresetInputs', () => {
  it('accepts a valid form (empty problem list)', () => {
    const d = descriptor([field({ key: 'name', type: 'text', required: true })])
    expect(validateInitiativePresetInputs(d, { name: 'hello' })).toEqual([])
  })

  it('flags unknown keys', () => {
    const d = descriptor([field({ key: 'name' })])
    expect(validateInitiativePresetInputs(d, { name: 'x', bogus: 'y' })).toEqual([
      'Unknown field "bogus".',
    ])
  })

  it('requires a visible required field; an unchecked checkbox counts as unset', () => {
    const d = descriptor([field({ key: 'agree', type: 'checkbox', required: true })])
    expect(validateInitiativePresetInputs(d, {})).toEqual(['Field "agree" is required.'])
    expect(validateInitiativePresetInputs(d, { agree: false })).toEqual([
      'Field "agree" is required.',
    ])
    expect(validateInitiativePresetInputs(d, { agree: true })).toEqual([])
  })

  it('does not require a hidden field even when marked required', () => {
    const d = descriptor([
      field({ key: 'mode', type: 'text' }),
      field({
        key: 'child',
        type: 'text',
        required: true,
        showWhen: { key: 'mode', equals: 'advanced' },
      }),
    ])
    expect(validateInitiativePresetInputs(d, { mode: 'basic' })).toEqual([])
  })

  it('rejects a value of the wrong type for the field', () => {
    const d = descriptor([field({ key: 'count', type: 'number' })])
    expect(validateInitiativePresetInputs(d, { count: 'not-a-number' })).toEqual([
      'Field "count" has the wrong type for a number field.',
    ])
  })

  it('constrains a select value to its options', () => {
    const d = descriptor([
      field({ key: 'color', type: 'select', options: [{ value: 'r', label: 'Red' }] }),
    ])
    expect(validateInitiativePresetInputs(d, { color: 'r' })).toEqual([])
    expect(validateInitiativePresetInputs(d, { color: 'b' })).toEqual([
      'Field "color" has a value outside its options.',
    ])
  })

  it('constrains each checkbox-group entry to its options', () => {
    const d = descriptor([
      field({
        key: 'kinds',
        type: 'checkbox-group',
        options: [
          { value: 'a', label: 'A' },
          { value: 'b', label: 'B' },
        ],
      }),
    ])
    expect(validateInitiativePresetInputs(d, { kinds: ['a', 'b'] })).toEqual([])
    expect(validateInitiativePresetInputs(d, { kinds: ['a', 'z'] })).toEqual([
      'Field "kinds" has an option "z" outside its choices.',
    ])
  })

  it('rejects a path value that escapes the repo', () => {
    const d = descriptor([field({ key: 'dir', type: 'path' })])
    expect(validateInitiativePresetInputs(d, { dir: 'docs/rfcs' })).toEqual([])
    expect(validateInitiativePresetInputs(d, { dir: '../escape' })).toHaveLength(1)
  })
})

describe('sanitizeInitiativePresetInputs', () => {
  it('drops unknown keys and hidden fields, keeping visible declared values', () => {
    const d = descriptor([
      field({ key: 'mode', type: 'text' }),
      field({ key: 'child', type: 'path', showWhen: { key: 'mode', equals: 'advanced' } }),
    ])
    // `child` is hidden (mode !== advanced) and its stale value would escape the repo — it
    // must be dropped so a hidden field can never freeze an unvalidated value.
    const out = sanitizeInitiativePresetInputs(d, {
      mode: 'basic',
      child: '../escape',
      bogus: 'x',
    })
    expect(out).toEqual({ mode: 'basic' })
  })

  it('keeps a visible field value', () => {
    const d = descriptor([
      field({ key: 'mode', type: 'text' }),
      field({ key: 'child', type: 'path', showWhen: { key: 'mode', equals: 'advanced' } }),
    ])
    expect(sanitizeInitiativePresetInputs(d, { mode: 'advanced', child: 'docs' })).toEqual({
      mode: 'advanced',
      child: 'docs',
    })
  })
})

describe('renderInitiativePresetValue', () => {
  const withOptions = field({
    key: 'k',
    options: [
      { value: 'r', label: 'Red' },
      { value: 'g', label: 'Green' },
    ],
  })

  it('prefers an option label over the raw value', () => {
    expect(renderInitiativePresetValue(withOptions, 'r')).toBe('Red')
    expect(renderInitiativePresetValue(withOptions, 'unknown')).toBe('unknown')
  })

  it('joins a multi-select on labels', () => {
    expect(renderInitiativePresetValue(withOptions, ['r', 'g'])).toBe('Red, Green')
  })

  it('renders booleans as Yes/No and numbers as strings', () => {
    const f = field({ key: 'k' })
    expect(renderInitiativePresetValue(f, true)).toBe('Yes')
    expect(renderInitiativePresetValue(f, false)).toBe('No')
    expect(renderInitiativePresetValue(f, 42)).toBe('42')
  })
})
