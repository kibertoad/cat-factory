import { describe, expect, it } from 'vitest'
import { isCredentialWaitParked, mayResumeCredentialWait } from './credential-wait.js'

describe('isCredentialWaitParked', () => {
  it('needs both the recorded wait and a pending approval', () => {
    const credentialWait = { raisedAt: 1 }
    expect(isCredentialWaitParked({ credentialWait, approval: { status: 'pending' } })).toBe(true)
    expect(isCredentialWaitParked({ credentialWait, approval: { status: 'approved' } })).toBe(false)
    expect(isCredentialWaitParked({ credentialWait, approval: null })).toBe(false)
    expect(isCredentialWaitParked({ credentialWait: null, approval: { status: 'pending' } })).toBe(
      false,
    )
  })
})

describe('mayResumeCredentialWait', () => {
  it('admits only the initiator when the run records one', () => {
    expect(mayResumeCredentialWait('usr_a', 'usr_a')).toBe(true)
    expect(mayResumeCredentialWait('usr_a', 'usr_b')).toBe(false)
    expect(mayResumeCredentialWait('usr_a', null)).toBe(false)
  })

  it('admits anyone on a run with no recorded initiator', () => {
    expect(mayResumeCredentialWait(null, null)).toBe(true)
    expect(mayResumeCredentialWait(undefined, 'usr_b')).toBe(true)
  })
})
