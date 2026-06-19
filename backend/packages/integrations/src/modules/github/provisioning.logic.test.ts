import { describe, expect, it, vi } from 'vitest'
import type {
  CreateRepoInput,
  GitHubProvisioningClient,
  InstallationPermissions,
  ProvisionedRepo,
} from '@cat-factory/kernel'
import { RepoProvisioningService } from './RepoProvisioningService.js'
import { canCreateRepo } from './provisioning.logic.js'

// The two-App provisioning model (ADR 0005): a workspace's bound installation
// belongs to either the privileged App (carries Administration: write → direct
// creation) or the restricted App (no grant → delegated to the manual flow).

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

// A configurable fake of the provisioning client.
function fakeClient(
  overrides: {
    permissions?: InstallationPermissions
    createRepoInOrg?: GitHubProvisioningClient['createRepoInOrg']
  } = {},
): GitHubProvisioningClient {
  return {
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
  it('creates directly when the installation has administration: write', async () => {
    const client = fakeClient({ permissions: { administration: 'write' } })
    const svc = new RepoProvisioningService({ client })

    const result = await svc.provision(100, input)

    expect(result).toEqual({ status: 'created', repo })
    expect(client.createRepoInOrg).toHaveBeenCalledWith(100, input)
  })

  it('delegates without an API call when the grant is insufficient', async () => {
    const client = fakeClient({ permissions: { administration: 'read' } })
    const svc = new RepoProvisioningService({ client })

    expect(await svc.provision(100, input)).toEqual({
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

    expect(await svc.provision(100, input)).toEqual({ status: 'delegated', reason: 'forbidden' })
  })

  it('delegates on a 422 "already exists" so the existing repo path takes over', async () => {
    const client = fakeClient({
      permissions: { administration: 'write' },
      createRepoInOrg: async () => {
        throw Object.assign(new Error('Unprocessable'), { status: 422 })
      },
    })
    const svc = new RepoProvisioningService({ client })

    expect(await svc.provision(100, input)).toEqual({
      status: 'delegated',
      reason: 'already_exists',
    })
  })

  it('propagates unexpected failures', async () => {
    const client = fakeClient({
      permissions: { administration: 'write' },
      createRepoInOrg: async () => {
        throw Object.assign(new Error('Server error'), { status: 500 })
      },
    })
    const svc = new RepoProvisioningService({ client })

    await expect(svc.provision(100, input)).rejects.toThrow('Server error')
  })
})
