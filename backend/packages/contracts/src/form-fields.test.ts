import { describe, expect, it } from 'vitest'
import * as v from 'valibot'
import {
  DESCRIPTOR_FIELD_VALUE_MAX,
  descriptorFieldDefaults,
  descriptorFieldValuesSchema,
  isDescriptorFieldVisible,
  renderDescriptorFieldValue,
  sanitizeDescriptorFields,
  validateDescriptorFields,
  withDescriptorFieldDefaults,
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

  it('REFUSES a declared maxLength above the value bound, which could never be filled', () => {
    // A descriptor allowed to declare more than the bag itself carries would render an input that
    // accepts what the request schema then refuses, and that refusal arrives as a raw schema error
    // rather than the readable per-field message above.
    expect(() =>
      v.parse(taskTypeFieldDescriptorSchema, {
        key: 'notes',
        label: 'Notes',
        type: 'textarea',
        maxLength: DESCRIPTOR_FIELD_VALUE_MAX,
      }),
    ).not.toThrow()
    expect(() =>
      v.parse(taskTypeFieldDescriptorSchema, {
        key: 'notes',
        label: 'Notes',
        type: 'textarea',
        maxLength: DESCRIPTOR_FIELD_VALUE_MAX + 1,
      }),
    ).toThrow()
  })
})

describe('validateDescriptorFields: the shared numeric bounds', () => {
  it('enforces declared min/max where the value is FROZEN, not only in the input', () => {
    // The bound a gate declares for `maxAttempts` has to hold for a value filled over the API or
    // typed into a hand-authored pipeline, or the only remaining defence is the reader silently
    // clamping — behaviour nobody asked for and nobody is told about.
    const fields = [field({ key: 'maxAttempts', type: 'number', min: 1, max: 10 })]
    expect(validateDescriptorFields(fields, { maxAttempts: 3 })).toEqual([])
    expect(validateDescriptorFields(fields, { maxAttempts: 0 })).toEqual([
      'Field "maxAttempts" must be at least 1.',
    ])
    expect(validateDescriptorFields(fields, { maxAttempts: 11 })).toEqual([
      'Field "maxAttempts" must be at most 10.',
    ])
  })

  it('ignores min/max for a non-numeric answer', () => {
    const fields = [field({ key: 'name', type: 'text', min: 5 })]
    expect(validateDescriptorFields(fields, { name: 'ab' })).toEqual([])
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

  it('drops a value validation never type-checked, so it cannot be frozen', () => {
    // `validateDescriptorFields` short-circuits on a value that says nothing, which means a `false`
    // on a text field passes NO type check. Freezing it would put a wrong-typed answer on the
    // entity that the prompt fold then renders to every agent (`notes: false` reads as `No`), and
    // would claim a bag was collected when nothing was. The API is the door this comes through:
    // the form renderer drops these at the edit.
    const text = [field({ key: 'notes', type: 'textarea' })]
    expect(validateDescriptorFields(text, { notes: false })).toEqual([])
    expect(sanitizeDescriptorFields(text, { notes: false })).toEqual({})
    expect(sanitizeDescriptorFields(text, { notes: '   ' })).toEqual({})
    const ops = [field({ key: 'ops', type: 'checkbox-group' })]
    expect(sanitizeDescriptorFields(ops, { ops: [] })).toEqual({})
  })

  it('KEEPS an explicit false on a checkbox, the one unfilled value that is an answer', () => {
    // The opt-OUT of a default-ON toggle. Absent and `false` are the same value there and opposite
    // facts, so a consumer reading `inputs[key] !== false` needs the `false` to survive.
    const gate = [field({ key: 'humanReview', type: 'checkbox', default: 'true' })]
    expect(sanitizeDescriptorFields(gate, { humanReview: false })).toEqual({ humanReview: false })
    // A numeric 0 is a real answer too (the strict emptiness comparisons never match it).
    expect(
      sanitizeDescriptorFields([field({ key: 'depth', type: 'number' })], { depth: 0 }),
    ).toEqual({ depth: 0 })
  })

  it('renders a value with no descriptor at all, rather than needing a fake one', () => {
    // A bag key outlives the descriptor that declared it (a node whose build predates a
    // re-registration still renders the row it stored), so the renderer takes an absent field.
    expect(renderDescriptorFieldValue(undefined, ['create', 'list'])).toBe('create, list')
    expect(renderDescriptorFieldValue(undefined, true)).toBe('Yes')
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

// Defaults are applied at the DOOR (`withDescriptorFieldDefaults`), not in the form. They used to
// be seeded only by the SPA, which made a field that is both `required` and defaulted pass from a
// browser and fail from every headless caller: the form had already filled it in, and a script had
// no way to know it must restate a value the deployment already declared.
describe('descriptor defaults', () => {
  it('types each default the way the wire bag expects', () => {
    expect(
      descriptorFieldDefaults([
        field({ key: 'entity', default: 'Order' }),
        field({ key: 'depth', type: 'number', default: '3' }),
        field({ key: 'review', type: 'checkbox', default: 'true' }),
        field({ key: 'ops', type: 'checkbox-group', defaultValues: ['create'] }),
      ]),
    ).toEqual({ entity: 'Order', depth: 3, review: true, ops: ['create'] })
  })

  it('seeds nothing for a field with no meaningful default', () => {
    // An unfilled optional field must stay ABSENT, which is what validation reads as unset and what
    // keeps an empty value off the frozen row.
    expect(
      descriptorFieldDefaults([
        field({ key: 'notes' }),
        field({ key: 'entity', default: '' }),
        field({ key: 'depth', type: 'number', default: 'not-a-number' }),
        field({ key: 'review', type: 'checkbox' }),
        field({ key: 'ops', type: 'checkbox-group', defaultValues: [] }),
      ]),
    ).toEqual({})
  })

  it('answers a required-and-defaulted field the caller omitted', () => {
    // The whole point: this bag was a 422 for every non-SPA caller and is now the same submission
    // the create form would have made.
    const fields = [
      field({ key: 'entity', required: true }),
      field({
        key: 'auth',
        type: 'select',
        required: true,
        default: 'service',
        options: [{ value: 'service', label: 'Service token' }],
      }),
    ]
    expect(validateDescriptorFields(fields, { entity: 'Order' })).toHaveLength(1)
    const filled = withDescriptorFieldDefaults(fields, { entity: 'Order' })
    expect(validateDescriptorFields(fields, filled)).toEqual([])
    expect(filled.auth).toBe('service')
  })

  it('never overwrites a value the caller sent, including a default-ON checkbox opt-OUT', () => {
    // `false` on a default-ON checkbox is the one place absence and the value are different facts.
    // Re-seeding `true` over it would make that toggle unpressable for everything but the form.
    const fields = [
      field({ key: 'review', type: 'checkbox', default: 'true' }),
      field({ key: 'entity', default: 'Order' }),
    ]
    expect(withDescriptorFieldDefaults(fields, { review: false, entity: 'Refund' })).toEqual({
      review: false,
      entity: 'Refund',
    })
  })

  it('leaves a bag with no defaults to seed byte-identical', () => {
    const fields = [field({ key: 'entity' }), field({ key: 'notes', type: 'textarea' })]
    expect(withDescriptorFieldDefaults(fields, { entity: 'Order' })).toEqual({ entity: 'Order' })
    expect(withDescriptorFieldDefaults([], {})).toEqual({})
  })
})
