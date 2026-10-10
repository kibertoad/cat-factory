import { describe, expect, it } from 'vitest'
import { resolveSsoConfig } from '../src/config/sso.js'
import type { SsoEnv } from '../src/config/sso.js'
import { isConfigValidationError } from '../src/config/problems.js'

// `resolveSsoConfig` is the ONE place both facades parse enterprise-SSO configuration, so its
// refusals are the deployment's boot guards. Each one exists because the alternative is a
// deployment that looks configured and is not — the failure an operator wiring SSO for a security
// review would not notice.

const OK: SsoEnv = {
  AUTH_SSO_ISSUER_URL: 'https://acme.okta.com/oauth2/default',
  AUTH_SSO_CLIENT_ID: 'cid',
  AUTH_SSO_CLIENT_SECRET: 'shhh',
}
const SAFE = { strongSessionSecret: true, devOpen: false }

/** The variable a refusal names, so a test asserts the operator-facing diagnostic, not just a throw. */
function refusalKey(env: SsoEnv, opts = SAFE): string {
  try {
    resolveSsoConfig(env, opts)
  } catch (err) {
    if (isConfigValidationError(err)) return err.problems[0]!.key
    throw err
  }
  throw new Error('expected resolveSsoConfig to refuse')
}

describe('resolveSsoConfig', () => {
  it('is undefined when none of its variables are set', () => {
    // SSO is opt-in: the overwhelmingly common case must cost nothing and refuse nothing.
    expect(resolveSsoConfig({}, SAFE)).toBeUndefined()
  })

  it('resolves the defaults from the three required variables', () => {
    expect(resolveSsoConfig(OK, SAFE)).toEqual({
      issuerUrl: 'https://acme.okta.com/oauth2/default',
      clientId: 'cid',
      clientSecret: 'shhh',
      label: 'Single sign-on',
      scopes: 'openid profile email',
      redirectUrl: '',
      allowedEmailDomains: [],
      groupsClaim: 'groups',
      requiredGroups: [],
    })
  })

  it('accepts a discovery URL as well as an issuer URL, normalising to the issuer', () => {
    // Operators paste the two interchangeably; both name the same document, so refusing one would
    // be a config puzzle with no diagnostic value.
    const fromDiscovery = resolveSsoConfig(
      { ...OK, AUTH_SSO_ISSUER_URL: `${OK.AUTH_SSO_ISSUER_URL}/.well-known/openid-configuration` },
      SAFE,
    )
    expect(fromDiscovery?.issuerUrl).toBe(OK.AUTH_SSO_ISSUER_URL)
    expect(
      resolveSsoConfig({ ...OK, AUTH_SSO_ISSUER_URL: `${OK.AUTH_SSO_ISSUER_URL}/` }, SAFE)
        ?.issuerUrl,
    ).toBe(OK.AUTH_SSO_ISSUER_URL)
  })

  it('always requests `openid`, whatever the operator listed', () => {
    // Without it the response carries no ID token and the flow degrades to bare OAuth.
    expect(resolveSsoConfig({ ...OK, AUTH_SSO_SCOPES: 'email groups' }, SAFE)?.scopes).toBe(
      'openid email groups',
    )
    expect(resolveSsoConfig({ ...OK, AUTH_SSO_SCOPES: 'openid email' }, SAFE)?.scopes).toBe(
      'openid email',
    )
  })

  it('lowercases the domain and group allowlists', () => {
    const cfg = resolveSsoConfig(
      {
        ...OK,
        AUTH_SSO_ALLOWED_EMAIL_DOMAINS: 'Acme.com, Acme-Labs.com',
        AUTH_SSO_REQUIRED_GROUPS: 'Engineering,Ops',
      },
      SAFE,
    )
    expect(cfg?.allowedEmailDomains).toEqual(['acme.com', 'acme-labs.com'])
    expect(cfg?.requiredGroups).toEqual(['engineering', 'ops'])
  })

  it('refuses a PARTIAL configuration, naming the first missing variable', () => {
    // Disabling quietly would leave an operator who believes SSO is live on the consumer logins
    // they adopted SSO to replace.
    expect(refusalKey({ AUTH_SSO_ISSUER_URL: OK.AUTH_SSO_ISSUER_URL })).toBe('AUTH_SSO_CLIENT_ID')
    expect(refusalKey({ AUTH_SSO_CLIENT_ID: 'cid' })).toBe('AUTH_SSO_ISSUER_URL')
    expect(refusalKey({ ...OK, AUTH_SSO_CLIENT_SECRET: '  ' })).toBe('AUTH_SSO_CLIENT_SECRET')
  })

  it('refuses a non-https issuer on a non-loopback host', () => {
    expect(refusalKey({ ...OK, AUTH_SSO_ISSUER_URL: 'http://idp.acme.com' })).toBe(
      'AUTH_SSO_ISSUER_URL',
    )
    expect(refusalKey({ ...OK, AUTH_SSO_ISSUER_URL: 'not-a-url' })).toBe('AUTH_SSO_ISSUER_URL')
  })

  it("accepts plain http on loopback, for a provider on the developer's own machine", () => {
    for (const host of [
      'http://localhost:8080/realms/acme',
      'http://127.0.0.1:8080',
      'http://[::1]:8080',
    ]) {
      expect(resolveSsoConfig({ ...OK, AUTH_SSO_ISSUER_URL: host }, SAFE)).toBeDefined()
    }
  })

  it('refuses AUTH_DEV_OPEN alongside SSO', () => {
    // Dev-open serves every protected route anonymously, which cancels the access control SSO was
    // configured to enforce. Refused as a PAIR rather than one silently winning.
    expect(refusalKey(OK, { strongSessionSecret: true, devOpen: true })).toBe('AUTH_DEV_OPEN')
  })

  it('refuses a weak session secret, with no dev-open escape', () => {
    // SSO decides WHO signs in; the session it mints is the same HMAC bearer, so a
    // brute-forceable secret makes the IdP's guarantees irrelevant.
    expect(refusalKey(OK, { strongSessionSecret: false, devOpen: false })).toBe(
      'AUTH_SESSION_SECRET',
    )
  })

  it('refuses required groups with no claim to read them from', () => {
    // A gate that cannot be evaluated must not silently admit everyone.
    expect(
      refusalKey({ ...OK, AUTH_SSO_REQUIRED_GROUPS: 'engineering', AUTH_SSO_GROUPS_CLAIM: '' }),
    ).toBe('AUTH_SSO_GROUPS_CLAIM')
  })

  it('allows an empty groups claim when no group gate is configured', () => {
    expect(resolveSsoConfig({ ...OK, AUTH_SSO_GROUPS_CLAIM: '' }, SAFE)?.groupsClaim).toBe('')
  })
})
