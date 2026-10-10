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
    // A bag holding only blanks says nothing either — whitespace included, or the field would
    // render as an empty-looking line claiming the requester answered it.
    expect(describeCustomTaskType('org:introduce-api', { entity: '' }, descriptor)).toBeUndefined()
    expect(
      describeCustomTaskType('org:introduce-api', { entity: '  \n ' }, descriptor),
    ).toBeUndefined()
    expect(describeCustomTaskType('org:introduce-api', { legacy: ' ' }, descriptor)).toBeUndefined()
  })

  it('keeps a zero, which is an answer rather than a blank', () => {
    const context = describeCustomTaskType('org:introduce-api', { timeboxHours: 0 }, descriptor)
    expect(context?.fields).toEqual([{ key: 'timeboxHours', value: '0' }])
  })

  it('trims a value, so a textarea’s trailing newline does not break the line format', () => {
    const context = describeCustomTaskType(
      'org:introduce-api',
      { entity: '  Order  ', notes: 'Due Friday\n' },
      descriptor,
    )
    expect(context?.fields).toEqual([
      { key: 'entity', label: 'Entity', value: 'Order' },
      { key: 'notes', label: 'Notes', value: 'Due Friday' },
    ])
  })

  it('is absent for a BUILT-IN task type, whatever the bag holds', () => {
    // Not drift: a custom type is namespaced by construction, so `feature` has no descriptor
    // however current the build is. Rendering the raw id would head the section
    // `## Task parameters (feature)` over keys nothing declared — an operation identity the model
    // reads as a specification, where the raw-id fallback exists to name a WITHDRAWN one honestly.
    expect(describeCustomTaskType('feature', { entity: 'Order' }, undefined)).toBeUndefined()
    expect(describeCustomTaskType('bug', { foo: 'bar' }, undefined)).toBeUndefined()
    expect(describeCustomTaskType('', { foo: 'bar' }, undefined)).toBeUndefined()
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

  it('renders the widened value shapes as the form itself reads them', () => {
    // The shared descriptor-form vocabulary answers with booleans and multi-selects too, and the
    // fold goes through the SAME renderer the form review uses: captions over enum values, a
    // multi-select joined, a toggle as Yes/No. An empty multi-select says nothing and is left out.
    const withShapes: CustomTaskType = {
      ...descriptor,
      fields: [
        ...(descriptor.fields ?? []),
        {
          key: 'operations',
          label: 'Operations',
          type: 'checkbox-group',
          options: [
            { value: 'create', label: 'Create' },
            { value: 'list', label: 'List' },
          ],
        },
        { key: 'breaking', label: 'Breaking change', type: 'checkbox' },
        { key: 'skipped', label: 'Skipped', type: 'checkbox-group' },
      ],
    }
    const context = describeCustomTaskType(
      'org:introduce-api',
      { operations: ['create', 'list'], breaking: false, skipped: [] },
      withShapes,
    )
    expect(context?.fields).toEqual([
      { key: 'operations', label: 'Operations', value: 'Create, List' },
      // An explicit `false` on a default-ON toggle is the opt-OUT, which is exactly what such a
      // field records, so it renders rather than vanishing.
      { key: 'breaking', label: 'Breaking change', value: 'No' },
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
