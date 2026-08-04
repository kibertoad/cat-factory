import { describe, expect, it } from 'vitest'
import * as v from 'valibot'
import {
  descriptorFieldValuesSchema,
  isDescriptorFieldVisible,
  renderDescriptorFieldValue,
  sanitizeDescriptorFields,
  validateDescriptorFields,
  type DescriptorField,
} from './form-fields.js'
import { taskTypeFieldDescriptorSchema } from './task-types.js'
import { taskTypeFieldsSchema } from './primitives.js'

// The shared descriptor-form vocabulary. The rules themselves are covered per-behaviour by
// `initiative-preset.test.ts` (which drives the same functions through the preset wrappers); this
// file covers what only became true once the vocabulary was SHARED: the task-type surface's
// narrowed picklist, the widened value bag, and the descriptor-declared `maxLength` bound that the
// preset surface never had.
const field = (over: Partial<DescriptorField> & Pick<DescriptorField, 'key'>): DescriptorField => ({
  label: over.label ?? over.key,
  ...over,
})

describe('task-type field descriptors over the shared vocabulary', () => {
  it('admits the shapes an operation form needs', () => {
    for (const type of [
      'text',
      'textarea',
      'number',
      'select',
      'checkbox',
      'checkbox-group',
      'path',
    ]) {
      expect(() =>
        v.parse(taskTypeFieldDescriptorSchema, { key: 'k', label: 'K', type }),
      ).not.toThrow()
    }
    // `path` gains the repo-relative dir semantics, `checkbox-group` a `string[]` answer, and both
    // gain the `showWhen` / default attributes the preset form already had.
    expect(
      v.parse(taskTypeFieldDescriptorSchema, {
        key: 'dir',
        label: 'Directory',
        type: 'path',
        default: 'docs',
        showWhen: { key: 'style', equals: 'in-repo' },
      }).showWhen?.equals,
    ).toBe('in-repo')
  })

  it('REFUSES a password field, so a secret cannot be collected as a task parameter', () => {
    // Not a convention: a task field value reaches prompts, the board snapshot and telemetry, so the
    // type is excluded by construction and the capability-credential store is the home for a secret.
    expect(() =>
      v.parse(taskTypeFieldDescriptorSchema, { key: 'token', label: 'Token', type: 'password' }),
    ).toThrow()
  })

  it('treats an absent type as text', () => {
    const parsed = v.parse(taskTypeFieldDescriptorSchema, { key: 'k', label: 'K' })
    expect(parsed.type).toBeUndefined()
    expect(validateDescriptorFields([parsed], { k: 'hello' })).toEqual([])
    expect(validateDescriptorFields([parsed], { k: 42 })).toEqual([
      'Field "k" has the wrong type for a text field.',
    ])
  })
})

describe('the widened taskTypeFields.custom bag', () => {
  it('carries every descriptor-form value shape', () => {
    const parsed = v.parse(taskTypeFieldsSchema, {
      custom: { entity: 'Order', count: 3, urgent: true, operations: ['create', 'list'] },
    })
    expect(parsed.custom).toEqual({
      entity: 'Order',
      count: 3,
      urgent: true,
      operations: ['create', 'list'],
    })
  })

  it('still parses the pre-widening string/number rows unchanged, so nothing migrates', () => {
    expect(v.parse(descriptorFieldValuesSchema, { entity: 'Order', timebox: 4 })).toEqual({
      entity: 'Order',
      timebox: 4,
    })
  })

  it('keeps the bounds that stop a bag becoming an unbounded blob', () => {
    expect(() => v.parse(descriptorFieldValuesSchema, { k: 'x'.repeat(2001) })).toThrow()
    expect(() =>
      v.parse(descriptorFieldValuesSchema, { k: Array.from({ length: 51 }, () => 'x') }),
    ).toThrow()
    expect(() => v.parse(descriptorFieldValuesSchema, { k: { nested: true } })).toThrow()
  })
})

describe('validateDescriptorFields: the shared maxLength bound', () => {
  it('enforces a declared maxLength at the SERVER, not only in the input', () => {
    const fields = [field({ key: 'entity', type: 'text', maxLength: 5 })]
    expect(validateDescriptorFields(fields, { entity: 'Order' })).toEqual([])
    expect(validateDescriptorFields(fields, { entity: 'Orders!' })).toEqual([
      'Field "entity" exceeds its maximum length of 5.',
    ])
  })

  it('ignores maxLength for a non-string answer', () => {
    const fields = [field({ key: 'ops', type: 'checkbox-group', maxLength: 2 })]
    expect(validateDescriptorFields(fields, { ops: ['a', 'b', 'c'] })).toEqual([])
  })
})

describe('the rules read the same on a task type as on a preset', () => {
  const fields = [
    field({ key: 'style', type: 'select', options: [{ value: 'action', label: 'Action' }] }),
    field({ key: 'verb', type: 'text', showWhen: { key: 'style', equals: 'action' } }),
  ]

  it('hides a field whose condition fails, and drops its stale answer', () => {
    expect(isDescriptorFieldVisible(fields[1]!, { style: 'action' })).toBe(true)
    expect(isDescriptorFieldVisible(fields[1]!, {})).toBe(false)
    expect(sanitizeDescriptorFields(fields, { verb: 'refund' })).toEqual({})
  })

  it('renders a multi-select through its option captions', () => {
    const ops = field({
      key: 'ops',
      type: 'checkbox-group',
      options: [
        { value: 'create', label: 'Create' },
        { value: 'list', label: 'List' },
      ],
    })
    expect(renderDescriptorFieldValue(ops, ['create', 'list'])).toBe('Create, List')
    // An undeclared option still renders: values are authoritative, captions merely enrich.
    expect(renderDescriptorFieldValue(ops, ['create', 'archive'])).toBe('Create, archive')
  })
})
