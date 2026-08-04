import { describe, it, expect } from 'vitest'
import type { DescriptorField } from '~/types/domain'
import {
  defaultDescriptorValues,
  descriptorGroupValue,
  setDescriptorCheckbox,
  setDescriptorValue,
  toggleDescriptorGroupValue,
} from './descriptorFields'

const field = (over: Partial<DescriptorField> & Pick<DescriptorField, 'key'>): DescriptorField => ({
  label: over.key,
  ...over,
})

describe('defaultDescriptorValues', () => {
  it('seeds each declared default in its own contract shape', () => {
    // The form model is the wire shape, so a default has to arrive typed: the shared validator
    // refuses a `'3'` where a `number` field is declared, and would refuse it at create time too.
    expect(
      defaultDescriptorValues([
        field({ key: 'style', type: 'select', default: 'collection' }),
        field({ key: 'depth', type: 'number', default: '3' }),
        field({ key: 'gate', type: 'checkbox', default: 'true' }),
        field({ key: 'ops', type: 'checkbox-group', defaultValues: ['create', 'list'] }),
        field({ key: 'dir', type: 'path', default: 'docs' }),
      ]),
    ).toEqual({
      style: 'collection',
      depth: 3,
      gate: true,
      ops: ['create', 'list'],
      dir: 'docs',
    })
  })

  it('leaves a field with no meaningful default ABSENT rather than blank', () => {
    // Absent is what validation reads as unset, so seeding `''`/`[]`/`false` would both freeze an
    // empty answer and (for a required field) look filled to nothing that checks it.
    expect(
      defaultDescriptorValues([
        field({ key: 'entity', type: 'text' }),
        field({ key: 'notes', type: 'textarea', default: '' }),
        field({ key: 'gate', type: 'checkbox' }),
        field({ key: 'gateOff', type: 'checkbox', default: 'false' }),
        field({ key: 'ops', type: 'checkbox-group', defaultValues: [] }),
        field({ key: 'depth', type: 'number', default: 'not-a-number' }),
      ]),
    ).toEqual({})
  })

  it('copies a multi-select default, so editing the form cannot mutate the descriptor', () => {
    const ops = field({ key: 'ops', type: 'checkbox-group', defaultValues: ['create'] })
    const seeded = defaultDescriptorValues([ops])
    ;(seeded.ops as string[]).push('delete')
    expect(ops.defaultValues).toEqual(['create'])
  })
})

describe('setDescriptorValue', () => {
  it('drops a value the shared rules read as unset rather than freezing it', () => {
    // Absent is what `validateDescriptorFields` treats as unfilled and what
    // `sanitizeDescriptorFields` refuses to freeze, so the form must not hold one either: a
    // cleared field that stayed as `''`/`[]`/`false` would reach the wire as a collected answer.
    expect(setDescriptorValue({ entity: 'Order' }, 'entity', '')).toEqual({})
    expect(setDescriptorValue({ ops: ['create'] }, 'ops', [])).toEqual({})
    expect(setDescriptorValue({ gate: true }, 'gate', false)).toEqual({})
    expect(setDescriptorValue({ entity: 'Order' }, 'entity', undefined)).toEqual({})
  })

  it('keeps a numeric 0 but drops a half-typed number', () => {
    // `0` is a real answer. `NaN` is what `Number('')`/a partial entry yields, and it serialises to
    // `null` on the wire, which the value schema refuses: the submit would fail with a raw schema
    // error naming nothing the user typed.
    expect(setDescriptorValue({}, 'depth', 0)).toEqual({ depth: 0 })
    expect(setDescriptorValue({ depth: 3 }, 'depth', Number.NaN)).toEqual({})
  })

  it('does not mutate the bag it was given', () => {
    const before = { entity: 'Order' }
    expect(setDescriptorValue(before, 'style', 'action')).toEqual({
      entity: 'Order',
      style: 'action',
    })
    expect(before).toEqual({ entity: 'Order' })
  })
})

describe('setDescriptorCheckbox', () => {
  it('persists an explicit false ONLY for a default-ON toggle', () => {
    // A default-ON checkbox is the one field where absent and `false` are opposite facts: a
    // consumer reads the opt-out as `inputs[key] !== false` (the tech-migration preset's
    // `humanReview`), so dropping the `false` would make the toggle dead.
    const onByDefault = field({ key: 'humanReview', type: 'checkbox', default: 'true' })
    expect(setDescriptorCheckbox({}, onByDefault, false)).toEqual({ humanReview: false })
    expect(setDescriptorCheckbox({}, onByDefault, true)).toEqual({ humanReview: true })
    // A default-OFF checkbox never freezes a redundant `false`: absent already means unchecked.
    const offByDefault = field({ key: 'breaking', type: 'checkbox' })
    expect(setDescriptorCheckbox({ breaking: true }, offByDefault, false)).toEqual({})
  })
})

describe('toggleDescriptorGroupValue', () => {
  it('adds, removes and de-duplicates without freezing an empty selection', () => {
    expect(toggleDescriptorGroupValue({}, 'ops', 'create', true)).toEqual({ ops: ['create'] })
    expect(toggleDescriptorGroupValue({ ops: ['create'] }, 'ops', 'create', true)).toEqual({
      ops: ['create'],
    })
    expect(toggleDescriptorGroupValue({ ops: ['create', 'list'] }, 'ops', 'create', false)).toEqual(
      {
        ops: ['list'],
      },
    )
    // Unchecking the last option leaves the key ABSENT, not an empty array.
    expect(toggleDescriptorGroupValue({ ops: ['create'] }, 'ops', 'create', false)).toEqual({})
  })

  it('reads a wrong-shaped stored value as an empty selection', () => {
    // A bag can arrive from a probe prefill or a since-changed descriptor, so the reader narrows
    // rather than assuming: a scalar under a multi-select key must not throw in the renderer.
    expect(descriptorGroupValue({ ops: 'create' }, 'ops')).toEqual([])
    expect(toggleDescriptorGroupValue({ ops: 'create' }, 'ops', 'list', true)).toEqual({
      ops: ['list'],
    })
  })
})
