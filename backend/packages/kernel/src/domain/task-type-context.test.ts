import { describe, expect, it } from 'vitest'
import type { CustomTaskType } from '@cat-factory/contracts'
import { describeCustomTaskType } from './task-type-context.js'

const descriptor: CustomTaskType = {
  taskType: 'org:introduce-api',
  presentation: {
    label: 'Introduce API',
    icon: 'i-lucide-plug',
    color: '#0ea5e9',
    description: 'Expose functionality over HTTP.',
  },
  fields: [
    { key: 'entity', label: 'Entity', type: 'text' },
    {
      key: 'authRequirement',
      label: 'Auth requirement',
      type: 'select',
      options: [
        { value: 'service', label: 'Service-to-service machine token' },
        { value: 'end-user', label: 'End-user session' },
      ],
    },
    { key: 'notes', label: 'Notes', type: 'textarea' },
  ],
}

describe('describeCustomTaskType', () => {
  it('is absent when nothing was collected, so a prompt stays byte-identical', () => {
    expect(describeCustomTaskType('org:introduce-api', undefined, descriptor)).toBeUndefined()
    expect(describeCustomTaskType('org:introduce-api', {}, descriptor)).toBeUndefined()
    // A bag holding only blanks says nothing either.
    expect(describeCustomTaskType('org:introduce-api', { entity: '' }, descriptor)).toBeUndefined()
  })

  it('labels the values from the descriptor and renders an option caption', () => {
    const context = describeCustomTaskType(
      'org:introduce-api',
      { entity: 'Order', authRequirement: 'service' },
      descriptor,
    )
    expect(context?.label).toBe('Introduce API')
    expect(context?.fields).toEqual([
      { key: 'entity', label: 'Entity', value: 'Order' },
      {
        key: 'authRequirement',
        label: 'Auth requirement',
        value: 'Service-to-service machine token',
      },
    ])
  })

  it('orders declared fields by the descriptor, not by the bag', () => {
    const context = describeCustomTaskType(
      'org:introduce-api',
      { notes: 'Due Friday', entity: 'Order' },
      descriptor,
    )
    expect(context?.fields.map((f) => f.key)).toEqual(['entity', 'notes'])
  })

  it('keeps a bag key the descriptor does not declare, under its raw key', () => {
    // Drift may cost a LABEL and never a VALUE: a field renamed since the task was created is
    // still the brief the operation was invoked with.
    const context = describeCustomTaskType(
      'org:introduce-api',
      { entity: 'Order', legacyScope: 'read-only', timeboxHours: 8 },
      descriptor,
    )
    expect(context?.fields).toEqual([
      { key: 'entity', label: 'Entity', value: 'Order' },
      { key: 'legacyScope', value: 'read-only' },
      { key: 'timeboxHours', value: '8' },
    ])
  })

  it('degrades to raw keys and the raw id when no descriptor is registered', () => {
    // The state on a node whose build predates the registration, and after a type is withdrawn.
    const context = describeCustomTaskType(
      'org:introduce-api',
      { entity: 'Order', authRequirement: 'service' },
      undefined,
    )
    expect(context?.label).toBe('org:introduce-api')
    expect(context?.fields).toEqual([
      { key: 'entity', value: 'Order' },
      // No descriptor ⇒ no option captions either: the stored value is what is known.
      { key: 'authRequirement', value: 'service' },
    ])
  })
})
