import { describe, expect, it } from 'vitest'
import { LinearApiError, linearAuthHeader, unwrapLinearData } from './linear.client.js'

describe('linearAuthHeader', () => {
  it('sends a personal API key as the raw header value', () => {
    expect(linearAuthHeader({ apiKey: 'lin_api_x' })).toBe('lin_api_x')
  })

  it('sends an OAuth token as a Bearer (the future-ready variant)', () => {
    expect(linearAuthHeader({ token: 'oauth_x' })).toBe('Bearer oauth_x')
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
