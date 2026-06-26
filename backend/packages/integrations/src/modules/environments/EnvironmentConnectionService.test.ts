import { describe, expect, it } from 'vitest'
import type {
  Clock,
  EnvironmentConnectionRecord,
  EnvironmentConnectionRepository,
  EnvironmentManifest,
  EnvironmentProvider,
  ProviderConfigField,
  SecretCipher,
  Workspace,
  WorkspaceRepository,
} from '@cat-factory/kernel'
import { EnvironmentConnectionService } from './EnvironmentConnectionService.js'

// The manifest's `providerConfig` bag is the per-workspace config carrier for a NATIVE
// injected adapter (e.g. Kargo's project). It rides inside the `manifestJson` JSON column
// verbatim on both runtimes, so these tests pin that it round-trips through register →
// requireConnection unchanged — proving native adapters get their per-workspace config back.

const fakeCipher: SecretCipher = {
  encrypt: async (plaintext: string) => `enc:${plaintext}`,
  decrypt: async (cipher: string) => cipher.replace(/^enc:/, ''),
}

function fakeConnections(): EnvironmentConnectionRepository & {
  records: Map<string, EnvironmentConnectionRecord>
} {
  const records = new Map<string, EnvironmentConnectionRecord>()
  return {
    records,
    async getByWorkspace(workspaceId) {
      const r = records.get(workspaceId)
      return r && !r.deletedAt ? r : null
    },
    async upsert(record) {
      records.set(record.workspaceId, record)
    },
    async softDelete(workspaceId, at) {
      const r = records.get(workspaceId)
      if (r) r.deletedAt = at
    },
  }
}

const fakeWorkspaces = {
  async get(id: string): Promise<Workspace | null> {
    return { id, name: 'ws', createdAt: 0 } as unknown as Workspace
  },
} as unknown as WorkspaceRepository

const clock: Clock = { now: () => 1_700_000_000_000 }

function makeService(repo: EnvironmentConnectionRepository) {
  return new EnvironmentConnectionService({
    environmentConnectionRepository: repo,
    workspaceRepository: fakeWorkspaces,
    secretCipher: fakeCipher,
    clock,
  })
}

const baseManifest: EnvironmentManifest = {
  providerId: 'kargo',
  label: 'Kargo',
  baseUrl: 'https://envs.test/api',
  auth: { type: 'none' },
  provision: { method: 'POST', pathTemplate: '/prenvs' },
  response: {},
}

describe('EnvironmentConnectionService — providerConfig round-trip', () => {
  it('preserves a native adapter providerConfig bag through register → requireConnection', async () => {
    const repo = fakeConnections()
    const service = makeService(repo)
    const manifest: EnvironmentManifest = {
      ...baseManifest,
      providerConfig: { project: 'acme-web', linkKey: 'app', statusMap: { online: 'ready' } },
    }

    await service.register('ws1', { manifest, secrets: {} })

    const { manifest: resolved } = await service.requireConnection('ws1')
    expect(resolved.providerConfig).toEqual({
      project: 'acme-web',
      linkKey: 'app',
      statusMap: { online: 'ready' },
    })
  })

  it('leaves providerConfig undefined when the manifest omits it', async () => {
    const repo = fakeConnections()
    const service = makeService(repo)

    await service.register('ws1', { manifest: baseManifest, secrets: {} })

    const { manifest: resolved } = await service.requireConnection('ws1')
    expect(resolved.providerConfig).toBeUndefined()
  })

  it('preserves a deeply-nested providerConfig bag verbatim through the JSON column', async () => {
    const repo = fakeConnections()
    const service = makeService(repo)
    const manifest: EnvironmentManifest = {
      ...baseManifest,
      providerConfig: { project: 'acme-web', nested: { a: [1, 2], b: true } },
    }

    await service.register('ws1', { manifest, secrets: {} })

    const { manifest: resolved } = await service.requireConnection('ws1')
    expect(resolved.providerConfig).toEqual({ project: 'acme-web', nested: { a: [1, 2], b: true } })
  })
})

// describeProvider.missingRequired drives the unconfigured-provider banner: a `required`
// field with no `default` and no stored value is "missing". A secret is satisfied by the
// secret bundle; a non-secret native field by the manifest providerConfig bag; a defaulted
// field is never missing.
describe('EnvironmentConnectionService — describeProvider.missingRequired', () => {
  const NATIVE_FIELDS: ProviderConfigField[] = [
    { key: 'apiToken', label: 'API token', secret: true, required: true },
    { key: 'project', label: 'Project', required: true },
    { key: 'region', label: 'Region', required: true, default: 'us-east' },
    { key: 'note', label: 'Note' },
  ]
  const nativeProvider = {
    describeConfig: () => NATIVE_FIELDS,
  } as unknown as EnvironmentProvider

  function nativeService(repo: EnvironmentConnectionRepository) {
    return new EnvironmentConnectionService({
      environmentConnectionRepository: repo,
      workspaceRepository: fakeWorkspaces,
      secretCipher: fakeCipher,
      clock,
      environmentProvider: nativeProvider,
      providerKind: 'native',
      providerId: 'kargo',
      providerLabel: 'Kargo',
    })
  }

  it('reports every required-without-default field when nothing is registered', async () => {
    const descriptor = await nativeService(fakeConnections()).describeProvider('ws1')
    expect(descriptor.missingRequired).toEqual(['apiToken', 'project'])
  })

  it('clears fields satisfied by the secret bundle and the providerConfig bag', async () => {
    const repo = fakeConnections()
    const service = nativeService(repo)
    await service.register('ws1', {
      manifest: { ...baseManifest, providerConfig: { project: 'acme-web' } },
      secrets: { apiToken: 'tok' },
    })

    const descriptor = await service.describeProvider('ws1')
    expect(descriptor.missingRequired).toEqual([])
  })

  it('still flags a required field left unsupplied after registration', async () => {
    const repo = fakeConnections()
    const service = nativeService(repo)
    await service.register('ws1', {
      manifest: { ...baseManifest, providerConfig: { project: 'acme-web' } },
      secrets: {},
    })

    const descriptor = await service.describeProvider('ws1')
    expect(descriptor.missingRequired).toEqual(['apiToken'])
  })

  // A `baseUrl` field is persisted onto the manifest's `baseUrl` (not providerConfig / the
  // secret bundle), so the missingRequired read path must count it — otherwise a required
  // baseUrl field would stay "missing" forever and the banner could never clear.
  it('clears a required `baseUrl` field once the manifest carries a baseUrl', async () => {
    const repo = fakeConnections()
    const service = new EnvironmentConnectionService({
      environmentConnectionRepository: repo,
      workspaceRepository: fakeWorkspaces,
      secretCipher: fakeCipher,
      clock,
      environmentProvider: {
        describeConfig: () => [{ key: 'baseUrl', label: 'Base URL', required: true }],
      } as unknown as EnvironmentProvider,
      providerKind: 'native',
    })

    expect((await service.describeProvider('ws1')).missingRequired).toEqual(['baseUrl'])

    await service.register('ws1', { manifest: baseManifest, secrets: {} })
    expect((await service.describeProvider('ws1')).missingRequired).toEqual([])
  })

  // The descriptor exposes the saved manifest so the connect form can overlay edits onto it
  // (preserving stored providerConfig) — but it must never leak a secret VALUE.
  it('exposes the saved manifest without any secret value', async () => {
    const repo = fakeConnections()
    const service = nativeService(repo)
    await service.register('ws1', {
      manifest: { ...baseManifest, providerConfig: { project: 'acme-web', nested: { a: [1, 2] } } },
      secrets: { apiToken: 'super-secret-token' },
    })

    const descriptor = await service.describeProvider('ws1')
    expect((descriptor.savedManifest as { providerConfig: unknown }).providerConfig).toEqual({
      project: 'acme-web',
      nested: { a: [1, 2] },
    })
    expect(JSON.stringify(descriptor)).not.toContain('super-secret-token')
  })
})
