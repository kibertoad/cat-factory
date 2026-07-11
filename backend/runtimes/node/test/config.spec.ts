import { describe, expect, it } from 'vitest'
import { loadNodeConfig } from '../src/config.js'

// `loadNodeConfig` is the Node analogue of the Worker's `loadConfig`; the two MUST
// derive the same AppConfig shape from env (see CLAUDE.md "keep the runtimes
// symmetric"). This file guards the privileged-App tier (ADR 0005): Node used to omit
// `github.privilegedApp` entirely, which silently disabled repo provisioning on the
// Node + local facades. Mirrors the Worker's `loadGitHubConfig` semantics.

const ENCRYPTION_KEY = Buffer.alloc(32).toString('base64')

// A well-formed PKCS#8 PEM: the boot-time `requireGitHubAppPrivateKey` shape check (added by the
// error-message-coverage A3 work) now rejects a non-PKCS#8 key at config load, so the App keys in
// these fixtures must carry the `-----BEGIN PRIVATE KEY-----` boundaries and a base64-decodable
// body — the real key validation still happens later in `crypto.subtle.importKey`.
const VALID_APP_KEY = `-----BEGIN PRIVATE KEY-----\n${Buffer.from('pkcs8-body').toString(
  'base64',
)}\n-----END PRIVATE KEY-----`

// A minimal env that satisfies the always-on integrations (ENCRYPTION_KEY) and enables
// the GitHub App so the privileged tier is reachable. `AUTH_DEV_OPEN` keeps the new
// "remote node mode requires authentication" guard satisfied — these cases configure no
// login provider and are not about auth, so the dev-open hatch lets them load.
const GITHUB_ENABLED: NodeJS.ProcessEnv = {
  ENCRYPTION_KEY,
  AUTH_DEV_OPEN: 'true',
  GITHUB_APP_ID: '123',
  GITHUB_APP_PRIVATE_KEY: VALID_APP_KEY,
  GITHUB_WEBHOOK_SECRET: 'whsec',
}

describe('loadNodeConfig — privileged App tier (ADR 0005)', () => {
  it('parses privilegedApp when both its id and key are present', () => {
    const config = loadNodeConfig({
      ...GITHUB_ENABLED,
      GITHUB_PRIVILEGED_APP_ID: '456',
      GITHUB_PRIVILEGED_APP_PRIVATE_KEY: VALID_APP_KEY,
    })
    expect(config.github.privilegedApp).toEqual({ appId: '456' })
  })

  it('leaves privilegedApp undefined when the key is missing (half-set never authenticates)', () => {
    const config = loadNodeConfig({ ...GITHUB_ENABLED, GITHUB_PRIVILEGED_APP_ID: '456' })
    expect(config.github.privilegedApp).toBeUndefined()
  })

  it('leaves privilegedApp undefined when the id is missing', () => {
    const config = loadNodeConfig({
      ...GITHUB_ENABLED,
      GITHUB_PRIVILEGED_APP_PRIVATE_KEY: VALID_APP_KEY,
    })
    expect(config.github.privilegedApp).toBeUndefined()
  })

  it('leaves privilegedApp undefined when neither is set', () => {
    const config = loadNodeConfig(GITHUB_ENABLED)
    expect(config.github.privilegedApp).toBeUndefined()
  })

  // The privileged key's boot-time shape validation must fire on the SAME condition
  // `loadPrivilegedApp` activates the tier (both id AND key present) — a key with no id belongs to
  // an inactive tier that never consumes it, so validating it would fail boot on an unused
  // credential and diverge from the Worker's `loadPrivilegedApp`.
  it('does NOT validate the privileged key when its id is absent (tier inactive)', () => {
    expect(() =>
      loadNodeConfig({ ...GITHUB_ENABLED, GITHUB_PRIVILEGED_APP_PRIVATE_KEY: 'not-a-pkcs8-key' }),
    ).not.toThrow()
  })

  it('validates the privileged key once its id is present (tier active)', () => {
    expect(() =>
      loadNodeConfig({
        ...GITHUB_ENABLED,
        GITHUB_PRIVILEGED_APP_ID: '456',
        GITHUB_PRIVILEGED_APP_PRIVATE_KEY: 'not-a-pkcs8-key',
      }),
    ).toThrow(/GITHUB_PRIVILEGED_APP_PRIVATE_KEY/)
  })

  it('rejects a malformed default App key at config load', () => {
    expect(() =>
      loadNodeConfig({ ...GITHUB_ENABLED, GITHUB_APP_PRIVATE_KEY: 'not-a-pkcs8-key' }),
    ).toThrow(/GITHUB_APP_PRIVATE_KEY/)
  })
})

// Remote node mode has no anonymous tier (see config.ts): a hosted deployment must be
// able to authenticate users from the first request, so loadNodeConfig fails fast when no
// login provider is configured and the dev-open hatch is off.
describe('loadNodeConfig — remote node mode requires authentication', () => {
  it('throws when no auth provider is configured and dev-open is off', () => {
    expect(() => loadNodeConfig({ ENCRYPTION_KEY })).toThrow(/anonymous tier/i)
  })

  it('boots under the dev-open hatch with no provider (local dev / tests)', () => {
    expect(() => loadNodeConfig({ ENCRYPTION_KEY, AUTH_DEV_OPEN: 'true' })).not.toThrow()
  })

  it('boots with password login enabled and a strong session secret', () => {
    const config = loadNodeConfig({
      ENCRYPTION_KEY,
      AUTH_PASSWORD_ENABLED: 'true',
      AUTH_SESSION_SECRET: 'x'.repeat(32),
    })
    expect(config.auth.enabled).toBe(true)
  })

  it('boots with GitHub OAuth configured', () => {
    const config = loadNodeConfig({
      ENCRYPTION_KEY,
      GITHUB_OAUTH_CLIENT_ID: 'client-id',
      GITHUB_OAUTH_CLIENT_SECRET: 'client-secret',
      AUTH_SESSION_SECRET: 'x'.repeat(32),
    })
    expect(config.auth.enabled).toBe(true)
  })
})

// The system encryption key is validated up front (present + valid base64 + full AES-256
// length), mirroring the Worker's `loadConfig` and local mode — so a malformed key fails at
// config load with an actionable message rather than deep inside the first cipher build.
describe('loadNodeConfig — ENCRYPTION_KEY validation', () => {
  it('throws when ENCRYPTION_KEY is missing', () => {
    expect(() => loadNodeConfig({ AUTH_DEV_OPEN: 'true' })).toThrow(/ENCRYPTION_KEY/)
  })

  it('rejects a non-base64 ENCRYPTION_KEY', () => {
    expect(() =>
      loadNodeConfig({ ENCRYPTION_KEY: '%%%not-base64%%%', AUTH_DEV_OPEN: 'true' }),
    ).toThrow(/valid base64/)
  })

  it('rejects an ENCRYPTION_KEY that decodes to fewer than 32 bytes', () => {
    expect(() =>
      loadNodeConfig({
        ENCRYPTION_KEY: Buffer.alloc(16).toString('base64'),
        AUTH_DEV_OPEN: 'true',
      }),
    ).toThrow(/at least 32 bytes/)
  })
})

// `TESTING_NO_AUTH` is a stronger dev-open used by the e2e suite: it implies the open API of
// dev-open AND flags `auth.testingNoAuth` so the SPA renders the board anonymously. Honoured
// only outside a production-like ENVIRONMENT (see config.ts).
describe('loadNodeConfig — TESTING_NO_AUTH', () => {
  it('implies dev-open (boots with no provider) and flags testingNoAuth', () => {
    const config = loadNodeConfig({ ENCRYPTION_KEY, TESTING_NO_AUTH: 'true' })
    expect(config.auth.testingNoAuth).toBe(true)
    expect(config.auth.devOpen).toBe(true)
    expect(config.auth.enabled).toBe(false)
  })

  it('is refused in a production-like ENVIRONMENT (so it cannot re-open a deployment)', () => {
    expect(() =>
      loadNodeConfig({ ENCRYPTION_KEY, TESTING_NO_AUTH: 'true', ENVIRONMENT: 'production' }),
    ).toThrow(/anonymous tier/i)
  })

  it('defaults off — plain dev-open does not set testingNoAuth', () => {
    const config = loadNodeConfig({ ENCRYPTION_KEY, AUTH_DEV_OPEN: 'true' })
    expect(config.auth.testingNoAuth).toBe(false)
    expect(config.auth.devOpen).toBe(true)
  })
})
