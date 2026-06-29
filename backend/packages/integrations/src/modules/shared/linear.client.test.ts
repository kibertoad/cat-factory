import { describe, expect, it } from 'vitest'
import {
  LinearApiError,
  linearAuthFromCredentials,
  linearAuthHeader,
  unwrapLinearData,
} from './linear.client.js'

describe('linearAuthHeader', () => {
  it('sends a personal API key as the raw header value', () => {
    expect(linearAuthHeader({ apiKey: 'lin_api_x' })).toBe('lin_api_x')
  })

  it('sends an OAuth token as a Bearer (the future-ready variant)', () => {
    expect(linearAuthHeader({ token: 'oauth_x' })).toBe('Bearer oauth_x')
  })
})

describe('linearAuthFromCredentials', () => {
  it('prefers an OAuth token over an API key', () => {
    expect(linearAuthFromCredentials({ token: 't', apiKey: 'k' })).toEqual({ token: 't' })
    expect(linearAuthHeader(linearAuthFromCredentials({ token: 't' }))).toBe('Bearer t')
  })

  it('falls back to the API key (raw header)', () => {
    expect(linearAuthFromCredentials({ apiKey: 'k' })).toEqual({ apiKey: 'k' })
    expect(linearAuthHeader(linearAuthFromCredentials({ apiKey: 'k' }))).toBe('k')
  })

  it('throws when neither credential is present', () => {
    expect(() => linearAuthFromCredentials({})).toThrow()
  })
})

describe('unwrapLinearData', () => {
  it('returns data on success', () => {
    expect(unwrapLinearData(200, true, { data: { viewer: { name: 'Ada' } } })).toEqual({
      viewer: { name: 'Ada' },
    })
  })

  it('throws on a non-OK status, carrying it', () => {
    try {
      unwrapLinearData(401, false, { errors: [{ message: 'auth' }] })
      throw new Error('expected throw')
    } catch (err) {
      expect(err).toBeInstanceOf(LinearApiError)
      expect((err as LinearApiError).status).toBe(401)
    }
  })

  it('throws on a top-level GraphQL errors[] even with a 200', () => {
    expect(() => unwrapLinearData(200, true, { errors: [{ message: 'bad query' }] })).toThrow(
      /bad query/,
    )
  })

  it('throws when data is missing', () => {
    expect(() => unwrapLinearData(200, true, {})).toThrow()
  })
})
