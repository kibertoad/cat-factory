import { describe, expect, it } from 'vitest'
import {
  classifyServiceAccountToken,
  isFatalServiceAccountTokenProblem,
} from './service-account-token.js'

/** A structurally valid ServiceAccount JWT (three base64url segments). */
const JWT = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJjYXQtZmFjdG9yeSJ9.c2lnbmF0dXJl'

describe('classifyServiceAccountToken', () => {
  it('accepts a well-formed token', () => {
    expect(classifyServiceAccountToken(JWT)).toBeNull()
  })

  it('accepts surrounding whitespace, which every consumer trims anyway', () => {
    expect(classifyServiceAccountToken(`\n  ${JWT}\t\n`)).toBeNull()
  })

  it('rejects a line break INSIDE the token, the wrapped-terminal copy', () => {
    // The case the whole rule exists for: invisible in a password field, survives `.trim()`, and
    // reaches undici as a header value it refuses to build.
    const wrapped = `${JWT.slice(0, 20)}\n${JWT.slice(20)}`
    expect(classifyServiceAccountToken(wrapped)).toBe('whitespace')
  })

  it('rejects an interior space the same way', () => {
    expect(classifyServiceAccountToken(`${JWT.slice(0, 20)} ${JWT.slice(20)}`)).toBe('whitespace')
  })

  it('names the still-base64 `.data.token` value as its own mistake', () => {
    // `kubectl get secret … -o jsonpath={.data.token}` without the `| base64 -d`. It has a
    // different fix from a malformed token, so it must not collapse into `not-a-jwt`. The encoding
    // is spelled out rather than computed: contracts is runtime-neutral, with no `Buffer`.
    const encoded =
      'ZXlKaGJHY2lPaUpTVXpJMU5pSjkuZXlKemRXSWlPaUpqWVhRdFptRmpkRzl5ZVNKOS5jMmxuYm1GMGRYSmw='
    expect(classifyServiceAccountToken(encoded)).toBe('base64-encoded')
  })

  it('flags a token that is not JWT-shaped', () => {
    expect(classifyServiceAccountToken('not-a-real-token')).toBe('not-a-jwt')
  })

  it('says nothing about an empty value, which is the field`s own required-ness question', () => {
    expect(classifyServiceAccountToken('')).toBeNull()
    expect(classifyServiceAccountToken('   ')).toBeNull()
  })
})

describe('isFatalServiceAccountTokenProblem', () => {
  it('treats ONLY the impossible problem as fatal', () => {
    // The suspicious shapes stay overrulable: a `--token-auth-file` apiserver accepts an arbitrary
    // static bearer token, so a check that cannot be sure must not block a legitimate cluster.
    expect(isFatalServiceAccountTokenProblem('whitespace')).toBe(true)
    expect(isFatalServiceAccountTokenProblem('base64-encoded')).toBe(false)
    expect(isFatalServiceAccountTokenProblem('not-a-jwt')).toBe(false)
  })
})
