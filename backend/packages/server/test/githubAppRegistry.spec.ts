import type { GitHubInstallation, GitHubInstallationRepository } from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import type { GitHubAppAuth } from '../src/github/GitHubAppAuth.js'
import { GitHubAppRegistry } from '../src/github/GitHubAppRegistry.js'

// The multi-App resolver (ADR 0005). This logic is runtime-neutral and shared by
// every facade (Worker, Node, local), so a single suite here guards privileged-tier
// resolution for all of them — the per-facade glue only differs in how the registry
// is *built* from env (covered by each facade's config test).

// Sentinel auths: `authForApp` returns one of these by identity, so opaque objects
// stand in for the real GitHubAppAuth.
const defaultAuth = { id: 'default' } as unknown as GitHubAppAuth
const privilegedAuth = { id: 'privileged' } as unknown as GitHubAppAuth

let nextInstallationId = 1
function installation(appId: string | null): GitHubInstallation {
  return {
    installationId: nextInstallationId++,
    workspaceId: 'ws_1',
    accountId: null,
    accountLogin: 'acme',
    targetType: 'Organization',
    appId,
    cachedToken: null,
    tokenExpiresAt: null,
    createdAt: 0,
    deletedAt: null,
  }
}

const noInstallations = {
  getByInstallationId: async () => null,
} as unknown as GitHubInstallationRepository

function makeRegistry(withPrivileged: boolean) {
  return new GitHubAppRegistry({
    default: { appId: 'app-default', auth: defaultAuth },
    privileged: withPrivileged ? { appId: 'app-priv', auth: privilegedAuth } : undefined,
    installationRepository: noInstallations,
  })
}

describe('GitHubAppRegistry — privileged tier (ADR 0005)', () => {
  it('canCreateRepos is true only for an installation owned by the privileged App', () => {
    const reg = makeRegistry(true)
    expect(reg.canCreateRepos(installation('app-priv'))).toBe(true)
    expect(reg.canCreateRepos(installation('app-default'))).toBe(false)
    // A legacy null appId resolves to the default App, which never provisions.
    expect(reg.canCreateRepos(installation(null))).toBe(false)
  })

  it('canCreateRepos is always false when no privileged App is configured', () => {
    const reg = makeRegistry(false)
    expect(reg.canCreateRepos(installation('app-priv'))).toBe(false)
    expect(reg.canCreateRepos(installation(null))).toBe(false)
  })

  it('routes auth to the privileged App for its id and the default App otherwise', () => {
    const reg = makeRegistry(true)
    expect(reg.authForApp('app-priv')).toBe(privilegedAuth)
    expect(reg.authForApp('app-default')).toBe(defaultAuth)
    expect(reg.authForApp(null)).toBe(defaultAuth)
    expect(reg.authForApp('unknown')).toBe(defaultAuth)
  })

  it('apps() includes the privileged App only when configured', () => {
    expect(
      makeRegistry(true)
        .apps()
        .map((a) => a.appId),
    ).toEqual(['app-default', 'app-priv'])
    expect(
      makeRegistry(false)
        .apps()
        .map((a) => a.appId),
    ).toEqual(['app-default'])
  })
})
