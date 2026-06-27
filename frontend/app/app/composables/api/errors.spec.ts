import { describe, expect, it } from 'vitest'
import { ApiError, apiErrorEnvelope, apiErrorStatus } from '~/composables/api/errors'

// The contract client (`sendByApiContract`) reports a declared non-2xx as a plain
// `{ statusCode, headers, body }` value — body under `.body`, NOT an Error. Before the
// `ApiError` wrap, every `instanceof Error` check rendered "[object Object]" and every
// `.data.error` reader (parseConflict / parseCredentialError / login + probe messages)
// silently returned nothing. These tests lock that in.

describe('ApiError', () => {
  const body = { error: { code: 'conflict', message: 'Nope', details: { reason: 'task_limit' } } }

  it('is a real Error carrying the server message, status, and body', () => {
    const e = new ApiError(409, body)
    expect(e).toBeInstanceOf(Error)
    expect(e.message).toBe('Nope') // not "[object Object]"
    expect(e.statusCode).toBe(409)
    expect(e.envelope).toEqual(body.error)
  })

  it('falls back to a status message when the body carries no envelope', () => {
    expect(new ApiError(500, 'gateway down').message).toBe('Request failed (HTTP 500)')
  })
})

describe('apiErrorEnvelope', () => {
  const envelope = { code: 'credential_required', message: 'Unlock', details: { vendor: 'claude' } }

  it('reads the envelope from a wrapped ApiError (contract client)', () => {
    expect(apiErrorEnvelope(new ApiError(428, { error: envelope }))).toEqual(envelope)
  })

  it('reads the envelope from a bare { body } value (contract client, unwrapped)', () => {
    expect(apiErrorEnvelope({ statusCode: 428, body: { error: envelope } })).toEqual(envelope)
  })

  it('reads the envelope from a legacy $fetch FetchError (body under .data)', () => {
    expect(apiErrorEnvelope({ statusCode: 428, data: { error: envelope } })).toEqual(envelope)
  })

  it('returns undefined for a network/non-API error', () => {
    expect(apiErrorEnvelope(new Error('socket hang up'))).toBeUndefined()
    expect(apiErrorEnvelope(undefined)).toBeUndefined()
  })
})

describe('apiErrorStatus', () => {
  it('reads .statusCode (contract client) and .status (legacy)', () => {
    expect(apiErrorStatus(new ApiError(503, {}))).toBe(503)
    expect(apiErrorStatus({ status: 500 })).toBe(500)
    expect(apiErrorStatus(new Error('x'))).toBeUndefined()
  })
})
