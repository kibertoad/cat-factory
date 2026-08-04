import { describe, it, expect } from 'vitest'
import type { DescriptorField } from '~/types/domain'
import { defaultDescriptorValues } from './descriptorFields'

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
