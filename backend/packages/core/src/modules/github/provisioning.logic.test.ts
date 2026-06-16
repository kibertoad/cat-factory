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
  permissions: InstallationPermissions,
  create?: GitHubProvisioningClient['createRepoInOrg'],
): GitHubProvisioningClient {
  return {
    getGrantedPermissions: vi.fn(async () => permissions),
    createRepoInOrg: vi.fn(create ?? (async () => repo)),
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
    const client = fakeClient({ administration: 'write' })
    const fallback = vi.fn()
    const svc = new RepoProvisioningService({ client, fallback })

    const result = await svc.provision(100, input)

    expect(result).toEqual({ status: 'created', repo })
    expect(client.createRepoInOrg).toHaveBeenCalledWith(100, input)
    expect(fallback).not.toHaveBeenCalled()
  })

  it('delegates without an API call when the grant is insufficient', async () => {
    const client = fakeClient({ administration: 'read' })
    const fallback = vi.fn(async () => ({ status: 'delegated' as const, detail: 'queued' }))
    const svc = new RepoProvisioningService({ client, fallback })

    const result = await svc.provision(100, input)

    expect(result).toEqual({ status: 'delegated', detail: 'queued' })
    expect(fallback).toHaveBeenCalledWith(input, 'insufficient_permissions')
    // Proactive guard: never even attempts the create.
    expect(client.createRepoInOrg).not.toHaveBeenCalled()
  })

  it('falls back when GitHub forbids the create despite the proactive check', async () => {
    const client = fakeClient({ administration: 'write' }, async () => {
      throw Object.assign(new Error('Forbidden'), { status: 403 })
    })
    const fallback = vi.fn(async () => ({ status: 'delegated' as const }))
    const svc = new RepoProvisioningService({ client, fallback })

    const result = await svc.provision(100, input)

    expect(result).toEqual({ status: 'delegated' })
    expect(fallback).toHaveBeenCalledWith(input, 'forbidden')
  })

  it('propagates non-403 failures', async () => {
    const client = fakeClient({ administration: 'write' }, async () => {
      throw Object.assign(new Error('Server error'), { status: 500 })
    })
    const fallback = vi.fn()
    const svc = new RepoProvisioningService({ client, fallback })

    await expect(svc.provision(100, input)).rejects.toThrow('Server error')
    expect(fallback).not.toHaveBeenCalled()
  })
})
