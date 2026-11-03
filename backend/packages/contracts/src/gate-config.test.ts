import { describe, expect, it } from 'vitest'
import type { DescriptorField } from './form-fields.js'
import { effectiveGateConfigFields } from './gate-config.js'

// The ONE composition every reader of a step's gate parameters goes through (validation, the
// engine's freeze, the builder's render). These pin what "unanswered" means, because a narrower
// reading lets a blank from a headless caller suppress a default the gate declared.

const FIELDS: DescriptorField[] = [
  { key: 'soakMinutes', label: 'Soak', type: 'number', default: '15' },
  { key: 'channel', label: 'Channel', type: 'text', default: '#ops' },
  {
    key: 'tags',
    label: 'Tags',
    type: 'checkbox-group',
    options: [{ value: 'a', label: 'A' }],
    defaultValues: ['a'],
  },
  { key: 'notify', label: 'Notify', type: 'checkbox', default: 'true' },
]

describe('effectiveGateConfigFields', () => {
  it('fills every unanswered field with its declared default', () => {
    expect(effectiveGateConfigFields(FIELDS, undefined)).toEqual({
      soakMinutes: 15,
      channel: '#ops',
      tags: ['a'],
      notify: true,
    })
  })

  it('treats a blank string or an empty selection as unanswered', () => {
    expect(effectiveGateConfigFields(FIELDS, { channel: '  ', tags: [] })).toMatchObject({
      channel: '#ops',
      tags: ['a'],
    })
  })

  it('keeps an explicit answer, including the opt-out of a default-ON checkbox', () => {
    expect(effectiveGateConfigFields(FIELDS, { soakMinutes: 60, notify: false })).toMatchObject({
      soakMinutes: 60,
      notify: false,
    })
  })

  it('keeps a key the gate does not declare, so validation still refuses it', () => {
    expect(effectiveGateConfigFields(FIELDS, { nosuchknob: 3 })).toMatchObject({ nosuchknob: 3 })
  })
})
