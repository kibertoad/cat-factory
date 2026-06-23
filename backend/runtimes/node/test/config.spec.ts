import { describe, expect, it } from 'vitest'
import { loadNodeConfig } from '../src/config.js'

// `loadNodeConfig` is the Node analogue of the Worker's `loadConfig`; the two MUST
// derive the same AppConfig shape from env (see CLAUDE.md "keep the runtimes
// symmetric"). This file guards the privileged-App tier (ADR 0005): Node used to omit
// `github.privilegedApp` entirely, which silently disabled repo provisioning on the
// Node + local facades. Mirrors the Worker's `loadGitHubConfig` semantics.

const ENCRYPTION_KEY = Buffer.alloc(32).toString('base64')

// A minimal env that satisfies the always-on integrations (ENCRYPTION_KEY) and enables
// the GitHub App so the privileged tier is reachable.
const GITHUB_ENABLED: NodeJS.ProcessEnv = {
  ENCRYPTION_KEY,
  GITHUB_APP_ID: '123',
  GITHUB_APP_PRIVATE_KEY: 'default-key',
  GITHUB_WEBHOOK_SECRET: 'whsec',
}

describe('loadNodeConfig — privileged App tier (ADR 0005)', () => {
  it('parses privilegedApp when both its id and key are present', () => {
    const config = loadNodeConfig({
      ...GITHUB_ENABLED,
      GITHUB_PRIVILEGED_APP_ID: '456',
      GITHUB_PRIVILEGED_APP_PRIVATE_KEY: 'privileged-key',
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
      GITHUB_PRIVILEGED_APP_PRIVATE_KEY: 'privileged-key',
    })
    expect(config.github.privilegedApp).toBeUndefined()
  })

  it('leaves privilegedApp undefined when neither is set', () => {
    const config = loadNodeConfig(GITHUB_ENABLED)
    expect(config.github.privilegedApp).toBeUndefined()
  })
})
