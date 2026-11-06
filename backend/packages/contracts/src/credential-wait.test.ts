import * as v from 'valibot'
import { describe, expect, it } from 'vitest'
import {
  isCredentialWaitParked,
  mayResumeCredentialWait,
  stepCredentialWaitSchema,
  type StepCredentialWait,
} from './credential-wait.js'

const personal: StepCredentialWait = { subject: 'personal', raisedAt: 1 }
const capability: StepCredentialWait = {
  subject: 'capability',
  raisedAt: 1,
  key: 'VENDOR_TOKEN',
  declaredBy: { kind: 'research-definition', id: 'acme:vendor' },
}

describe('isCredentialWaitParked', () => {
  it('needs both the recorded wait and a pending approval', () => {
    const credentialWait = personal
    expect(isCredentialWaitParked({ credentialWait, approval: { status: 'pending' } })).toBe(true)
    expect(isCredentialWaitParked({ credentialWait, approval: { status: 'approved' } })).toBe(false)
    expect(isCredentialWaitParked({ credentialWait, approval: null })).toBe(false)
    expect(isCredentialWaitParked({ credentialWait: null, approval: { status: 'pending' } })).toBe(
      false,
    )
  })
})

describe('mayResumeCredentialWait', () => {
  it('admits only the initiator to a personal wait when the run records one', () => {
    expect(mayResumeCredentialWait(personal, 'usr_a', 'usr_a')).toBe(true)
    expect(mayResumeCredentialWait(personal, 'usr_a', 'usr_b')).toBe(false)
    expect(mayResumeCredentialWait(personal, 'usr_a', null)).toBe(false)
    expect(mayResumeCredentialWait(personal, null, null)).toBe(true)
  })

  it('admits any member to a capability wait, and nobody to an unrecorded one', () => {
    expect(mayResumeCredentialWait(capability, 'usr_a', 'usr_b')).toBe(true)
    expect(mayResumeCredentialWait({ subject: 'unrecorded', raisedAt: 1 }, null, 'usr_a')).toBe(
      false,
    )
  })
})

describe('stepCredentialWaitSchema', () => {
  it('names a pre-subject wait as unrecorded rather than reading it as personal', () => {
    expect(v.parse(stepCredentialWaitSchema, { raisedAt: 7 })).toEqual({
      subject: 'unrecorded',
      raisedAt: 7,
    })
    expect(v.parse(stepCredentialWaitSchema, personal)).toEqual(personal)
    expect(v.parse(stepCredentialWaitSchema, capability)).toEqual(capability)
  })
})
