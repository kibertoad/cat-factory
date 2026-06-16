import { describe, expect, it, vi } from 'vitest'
import type {
  CreateRepoInput,
  GitHubProvisioningClient,
  InstallationPermissions,
  ProvisionedRepo,
} from '../../ports/github-provisioning'
import { RepoProvisioningService } from './RepoProvisioningService'
import { canCreateRepo, resolveAppTier } from './provisioning.logic'

// The two-App provisioning model (ADR 0005): privileged orgs use the App that
// carries `Administration: write` and get direct repo creation; everything else
// fails closed to the restricted tier and a delegated fallback.

describe('resolveAppTier', () => {
  const config = { privilegedOrgs: ['Acme', 'beta-labs'] }

  it('returns privileged for a listed org (case-insensitive)', () => {
    expect(resolveAppTier('acme', config)).toBe('privileged')
    expect(resolveAppTier('ACME', config)).toBe('privileged')
    expect(resolveAppTier('  beta-labs ', config)).toBe('privileged')
  })

  it('fails closed to restricted for unlisted or empty orgs', () => {
    expect(resolveAppTier('sensitive-corp', config)).toBe('restricted')
    expect(resolveAppTier('', config)).toBe('restricted')
    expect(resolveAppTier('   ', config)).toBe('restricted')
    expect(resolveAppTier('acme', { privilegedOrgs: [] })).toBe('restricted')
  })
})

describe('canCreateRepo', () => {
  it('requires repository administration: write', () => {
    expect(canCreateRepo({ administration: 'write' })).toBe(true)
  })

  it('rejects read-only or absent administration', () => {
    expect(canCreateRepo({ administration: 'read' })).toBe(false)
    expect(canCreateRepo({ contents: 'write' })).toBe(false)
    expect(canCreateRepo({})).toBe(false)
  })
})

// A configurable fake of the privileged provisioning client.
function fakeClient(
  overrides: Partial<GitHubProvisioningClient> & {
    permissions?: InstallationPermissions
    installationId?: number | null
  } = {},
): GitHubProvisioningClient {
  return {
    getOrgInstallationId: vi.fn(async () =>
      'installationId' in overrides ? (overrides.installationId ?? null) : 555,
    ),
    getGrantedPermissions: vi.fn(async () => overrides.permissions ?? {}),
    createRepoInOrg: vi.fn(overrides.createRepoInOrg ?? (async () => repo)),
  }
}

const repo: ProvisionedRepo = {
  githubId: 42,
  owner: 'acme',
  name: 'new-svc',
  defaultBranch: 'main',
  private: true,
}

const input: CreateRepoInput = { org: 'acme', name: 'new-svc', private: true }

describe('RepoProvisioningService', () => {
  it('creates directly when the privileged install has administration: write', async () => {
    const client = fakeClient({ permissions: { administration: 'write' }, installationId: 100 })
    const svc = new RepoProvisioningService({ client })

    const result = await svc.provision(input)

    expect(result).toEqual({ status: 'created', repo })
    expect(client.createRepoInOrg).toHaveBeenCalledWith(100, input)
  })

  it('delegates when the privileged App is not installed on the org', async () => {
    const client = fakeClient({ installationId: null })
    const svc = new RepoProvisioningService({ client })

    expect(await svc.provision(input)).toEqual({ status: 'delegated', reason: 'app_not_installed' })
    expect(client.getGrantedPermissions).not.toHaveBeenCalled()
    expect(client.createRepoInOrg).not.toHaveBeenCalled()
  })

  it('delegates without an API call when the grant is insufficient', async () => {
    const client = fakeClient({ permissions: { administration: 'read' } })
    const svc = new RepoProvisioningService({ client })

    expect(await svc.provision(input)).toEqual({
      status: 'delegated',
      reason: 'insufficient_permissions',
    })
    // Proactive guard: never even attempts the create.
    expect(client.createRepoInOrg).not.toHaveBeenCalled()
  })

  it('delegates when GitHub forbids the create despite the proactive check', async () => {
    const client = fakeClient({
      permissions: { administration: 'write' },
      createRepoInOrg: async () => {
        throw Object.assign(new Error('Forbidden'), { status: 403 })
      },
    })
    const svc = new RepoProvisioningService({ client })

    expect(await svc.provision(input)).toEqual({ status: 'delegated', reason: 'forbidden' })
  })

  it('delegates on a 422 "already exists" so the existing repo path takes over', async () => {
    const client = fakeClient({
      permissions: { administration: 'write' },
      createRepoInOrg: async () => {
        throw Object.assign(new Error('Unprocessable'), { status: 422 })
      },
    })
    const svc = new RepoProvisioningService({ client })

    expect(await svc.provision(input)).toEqual({ status: 'delegated', reason: 'already_exists' })
  })

  it('propagates unexpected failures', async () => {
    const client = fakeClient({
      permissions: { administration: 'write' },
      createRepoInOrg: async () => {
        throw Object.assign(new Error('Server error'), { status: 500 })
      },
    })
    const svc = new RepoProvisioningService({ client })

    await expect(svc.provision(input)).rejects.toThrow('Server error')
  })
})
