import type { GitHubInstallation, Workspace } from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import {
  createTierInstallationResolvers,
  type TierInstallationResolverDependencies,
} from './tier-installation-resolver.js'

// The account tier is the interesting half: `installation.accountId` is null for a
// per-workspace PAT connect and a GitHub account id for local PAT mode's synthetic rows,
// so resolution must fall back through the account's boards (the exact
// "No GitHub installation is available for this scope" bug on a browsable repo).

function installation(overrides: Partial<GitHubInstallation>): GitHubInstallation {
  return {
    installationId: 1,
    workspaceId: 'ws-1',
    accountId: null,
    accountLogin: 'octo',
    targetType: 'User',
    appId: null,
    provider: 'github',
    cachedToken: null,
    tokenExpiresAt: null,
    accessToken: null,
    createdAt: 1,
    deletedAt: null,
    ...overrides,
  }
}

function board(id: string, accountId: string | null): Workspace {
  return { id, name: id, description: null, createdAt: 1, accountId }
}

/**
 * `active` is every stored live row; `listActiveForAccount` narrows it exactly as the two SQL
 * implementations do (bound to the account directly, OR to one of the account's own boards), so
 * these cases still describe the same worlds they did when the resolver filtered in JS. The
 * global `listActive` is deliberately NOT wired: reaching for it would throw, which is what pins
 * the account tier to the scoped read the machine API can serve.
 */
function makeDeps(opts: {
  active: GitHubInstallation[]
  boards?: Record<string, Workspace[]>
  byWorkspace?: Record<string, GitHubInstallation>
}): TierInstallationResolverDependencies & { pointReads: string[] } {
  const pointReads: string[] = []
  return {
    pointReads,
    installations: {
      listActiveForAccount: async (accountId: string) => {
        const boardIds = new Set((opts.boards?.[accountId] ?? []).map((w) => w.id))
        return opts.active.filter((i) => i.accountId === accountId || boardIds.has(i.workspaceId))
      },
      getByWorkspace: async (workspaceId: string) => {
        pointReads.push(workspaceId)
        return opts.byWorkspace?.[workspaceId] ?? null
      },
    } as unknown as TierInstallationResolverDependencies['installations'],
    workspaces: {
      listByAccount: async (accountId: string) => opts.boards?.[accountId] ?? [],
    } as unknown as TierInstallationResolverDependencies['workspaces'],
  }
}

describe('createTierInstallationResolvers', () => {
  it('resolves the workspace tier by the direct board binding', async () => {
    const deps = makeDeps({
      active: [],
      byWorkspace: { 'ws-1': installation({ installationId: 42 }) },
    })
    const resolvers = createTierInstallationResolvers(deps)
    expect(await resolvers.forWorkspace('ws-1')).toBe(42)
    expect(await resolvers.forWorkspace('ws-none')).toBeNull()
  })

  it('prefers an installation bound to the account directly', async () => {
    const deps = makeDeps({
      active: [
        installation({ installationId: 7, accountId: 'acc-other' }),
        installation({ installationId: 8, accountId: 'acc-1' }),
      ],
    })
    expect(await createTierInstallationResolvers(deps).forAccount('acc-1')).toBe(8)
  })

  it("falls back to an installation belonging to one of the account's boards", async () => {
    // A PAT connect: accountId is null on the row, so the direct match misses.
    const deps = makeDeps({
      active: [
        installation({ installationId: 7, workspaceId: 'ws-foreign' }),
        installation({ installationId: 9, workspaceId: 'ws-mine' }),
      ],
      boards: { 'acc-1': [board('ws-mine', 'acc-1')] },
    })
    expect(await createTierInstallationResolvers(deps).forAccount('acc-1')).toBe(9)
  })

  it('provisions through one of the account boards when no active row matches (local PAT mode)', async () => {
    const deps = makeDeps({
      active: [],
      boards: { 'acc-1': [board('ws-a', 'acc-1'), board('ws-b', 'acc-1')] },
      byWorkspace: { 'ws-a': installation({ installationId: 11, workspaceId: 'ws-a' }) },
    })
    expect(await createTierInstallationResolvers(deps).forAccount('acc-1')).toBe(11)
    // Exactly ONE point read — never a per-board loop.
    expect(deps.pointReads).toEqual(['ws-a'])
  })

  it('resolves null for an account with no installation anywhere', async () => {
    const deps = makeDeps({ active: [installation({ installationId: 7 })] })
    expect(await createTierInstallationResolvers(deps).forAccount('acc-1')).toBeNull()
  })

  it('never reads the global installation list for the account tier', async () => {
    // The account tier goes through the SCOPED `listActiveForAccount`. A reach for the global
    // `listActive` — which no account-scoped machine token can be allowed to serve — must be a
    // hard failure here rather than something mothership mode discovers at dispatch.
    const deps = makeDeps({
      active: [installation({ installationId: 8, accountId: 'acc-1' })],
    })
    const installations = deps.installations as unknown as { listActive: () => Promise<unknown> }
    installations.listActive = async () => {
      throw new Error('the account tier must not read every tenant’s installations')
    }
    expect(await createTierInstallationResolvers(deps).forAccount('acc-1')).toBe(8)
  })

  it('keys forOwner off the tier', async () => {
    const deps = makeDeps({
      active: [installation({ installationId: 8, accountId: 'acc-1' })],
      byWorkspace: { 'ws-1': installation({ installationId: 42 }) },
    })
    const resolvers = createTierInstallationResolvers(deps)
    expect(await resolvers.forOwner('workspace', 'ws-1')).toBe(42)
    expect(await resolvers.forOwner('account', 'acc-1')).toBe(8)
  })
})
