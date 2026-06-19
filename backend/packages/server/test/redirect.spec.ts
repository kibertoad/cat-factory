import { describe, expect, it } from 'vitest'
import { pickPostLoginRedirect } from '../src/modules/auth/AuthController.js'

// pickPostLoginRedirect guards a token-exfiltration primitive: the session token is
// appended to the landing URL as a fragment, so an open redirect would hand a victim's
// session to an attacker. Only same-origin or explicitly-allowlisted origins may be
// honoured; everything else falls back to the safe origin-relative default.

const ORIGIN = 'https://app.example'

describe('pickPostLoginRedirect', () => {
  const cfg = { successRedirectUrl: '', allowedRedirectOrigins: ['https://trusted.example'] }

  it('a fixed successRedirectUrl short-circuits everything', () => {
    expect(
      pickPostLoginRedirect('https://evil.example', ORIGIN, {
        successRedirectUrl: 'https://fixed.example/home',
        allowedRedirectOrigins: [],
      }),
    ).toBe('https://fixed.example/home')
  })

  it('falls back to the origin root when no redirect is requested', () => {
    expect(pickPostLoginRedirect(undefined, ORIGIN, cfg)).toBe(`${ORIGIN}/`)
  })

  it('honours a same-origin redirect', () => {
    expect(pickPostLoginRedirect(`${ORIGIN}/board/1`, ORIGIN, cfg)).toBe(`${ORIGIN}/board/1`)
  })

  it('honours an explicitly-allowlisted cross-origin redirect', () => {
    expect(pickPostLoginRedirect('https://trusted.example/x', ORIGIN, cfg)).toBe(
      'https://trusted.example/x',
    )
  })

  it('rejects an un-allowlisted cross-origin redirect (open-redirect defence)', () => {
    expect(pickPostLoginRedirect('https://evil.example/steal', ORIGIN, cfg)).toBe(`${ORIGIN}/`)
  })

  it('rejects non-http(s) schemes and unparseable values', () => {
    expect(pickPostLoginRedirect('javascript:alert(1)', ORIGIN, cfg)).toBe(`${ORIGIN}/`)
    expect(pickPostLoginRedirect('::::not-a-url', ORIGIN, cfg)).toBe(`${ORIGIN}/`)
  })
})
