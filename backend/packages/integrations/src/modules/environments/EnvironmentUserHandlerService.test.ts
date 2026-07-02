import { describe, expect, it } from 'vitest'
import type {
  EnvironmentUserHandlerRecord,
  EnvironmentUserHandlerRepository,
  SecretCipher,
} from '@cat-factory/kernel'
import { EnvironmentUserHandlerService } from './EnvironmentUserHandlerService.js'
import { defaultEnvironmentBackendRegistry } from './environment-backends.js'

// EnvironmentUserHandlerService is the per-USER override store (local mode). These tests
// assert the validate-store-read round-trip, the secret-free projection, and the
// `resolveOverrides` mapping the provisioning resolver layers over the workspace handlers —
// including the engine→backendKind derivation (the per-user table has no backend_kind).

const fakeCipher: SecretCipher = {
  encrypt: async (plaintext: string) => `enc:${plaintext}`,
  decrypt: async (cipher: string) => cipher.replace(/^enc:/, ''),
}

function fakeRepo(): EnvironmentUserHandlerRepository & {
  records: EnvironmentUserHandlerRecord[]
} {
  const records: EnvironmentUserHandlerRecord[] = []
  const keyOf = (r: {
    userId: string
    workspaceId: string
    provisionType: string
    manifestId: string | null
  }) => `${r.userId}|${r.workspaceId}|${r.provisionType}|${r.manifestId ?? ''}`
  return {
    records,
    async listByUserWorkspace(userId, workspaceId) {
      return records.filter((r) => r.userId === userId && r.workspaceId === workspaceId)
    },
    async upsert(record) {
      const i = records.findIndex((r) => keyOf(r) === keyOf(record))
      if (i >= 0) records[i] = record
      else records.push(record)
    },
    async remove(userId, workspaceId, provisionType, manifestId) {
      const i = records.findIndex(
        (r) => keyOf(r) === keyOf({ userId, workspaceId, provisionType, manifestId }),
      )
      if (i >= 0) records.splice(i, 1)
    },
  }
}

function makeService(repo: EnvironmentUserHandlerRepository) {
  return new EnvironmentUserHandlerService({
    userHandlerRepository: repo,
    environmentBackendRegistry: defaultEnvironmentBackendRegistry(),
    secretCipher: fakeCipher,
    clock: { now: () => 1_700_000_000_000 },
  })
}

const KUBE_CONFIG = {
  engine: 'remote-kubernetes' as const,
  kubernetes: {
    label: 'My personal cluster',
    apiServerUrl: 'https://my-cluster.example:6443',
    url: { source: 'ingressTemplate' as const, hostTemplate: '{{branch}}.preview.example.com' },
  },
}

describe('EnvironmentUserHandlerService', () => {
  it('upserts, lists (secret-free), and removes a per-user override', async () => {
    const repo = fakeRepo()
    const svc = makeService(repo)

    const view = await svc.upsert('user-1', 'ws-1', {
      provisionType: 'kubernetes',
      config: KUBE_CONFIG,
      secrets: { apiToken: 'personal-token' },
    })
    expect(view.provisionType).toBe('kubernetes')
    expect(view.engine).toBe('remote-kubernetes')
    expect(view.secretKeys).toEqual(['apiToken'])
    expect(JSON.stringify(view)).not.toContain('personal-token')

    const listed = await svc.list('user-1', 'ws-1')
    expect(listed.map((h) => h.provisionType)).toEqual(['kubernetes'])
    expect(JSON.stringify(listed)).not.toContain('personal-token')
    // Scoped to the user+workspace.
    expect(await svc.list('user-2', 'ws-1')).toEqual([])

    await svc.remove('user-1', 'ws-1', 'kubernetes', null)
    expect(await svc.list('user-1', 'ws-1')).toEqual([])
  })

  it('maps overrides to connection records, deriving backendKind from the engine', async () => {
    const repo = fakeRepo()
    const svc = makeService(repo)
    await svc.upsert('user-1', 'ws-1', {
      provisionType: 'kubernetes',
      config: KUBE_CONFIG,
      secrets: { apiToken: 'personal-token' },
    })

    const overrides = await svc.resolveOverrides('user-1', 'ws-1')
    expect(overrides).toHaveLength(1)
    const o = overrides[0]!
    expect(o.provisionType).toBe('kubernetes')
    expect(o.engine).toBe('remote-kubernetes')
    // The per-user table has no backend_kind column — it's re-derived from the engine.
    expect(o.backendKind).toBe('kubernetes')
    expect(o.deletedAt).toBeNull()
    // The encrypted bundle rides through so the resolver can build a provider.
    expect(o.secretsCipher).toBe(`enc:${JSON.stringify({ apiToken: 'personal-token' })}`)
  })

  it('rejects an override missing a referenced secret value', async () => {
    const svc = makeService(fakeRepo())
    await expect(
      svc.upsert('user-1', 'ws-1', {
        provisionType: 'kubernetes',
        config: KUBE_CONFIG,
        secrets: {},
      }),
    ).rejects.toThrow(/Missing secret values/)
  })

  it('preserves the stored token on a non-secret edit and replaces it on a new value', async () => {
    const repo = fakeRepo()
    const svc = makeService(repo)
    await svc.upsert('user-1', 'ws-1', {
      provisionType: 'kubernetes',
      config: KUBE_CONFIG,
      secrets: { apiToken: 'personal-token' },
    })

    // Re-save with a changed label and NO secrets — the token must survive (no Missing-secret
    // throw) and still report as set.
    const edited = await svc.upsert('user-1', 'ws-1', {
      provisionType: 'kubernetes',
      config: {
        engine: 'remote-kubernetes',
        kubernetes: { ...KUBE_CONFIG.kubernetes, label: 'Renamed' },
      },
      secrets: {},
    })
    expect(edited.label).toBe('Renamed')
    expect(edited.secretKeys).toEqual(['apiToken'])
    expect((await svc.resolveOverrides('user-1', 'ws-1'))[0]!.secretsCipher).toBe(
      `enc:${JSON.stringify({ apiToken: 'personal-token' })}`,
    )

    // A new value replaces it.
    await svc.upsert('user-1', 'ws-1', {
      provisionType: 'kubernetes',
      config: KUBE_CONFIG,
      secrets: { apiToken: 'rotated' },
    })
    expect((await svc.resolveOverrides('user-1', 'ws-1'))[0]!.secretsCipher).toBe(
      `enc:${JSON.stringify({ apiToken: 'rotated' })}`,
    )
  })

  it('round-trips a remote-custom override carrying its acceptsManifestId', async () => {
    const repo = fakeRepo()
    const svc = makeService(repo)
    const view = await svc.upsert('user-1', 'ws-1', {
      provisionType: 'custom',
      manifestId: 'terraform',
      config: {
        engine: 'remote-custom',
        acceptsManifestId: 'terraform',
        manifest: {
          providerId: 'tf',
          label: 'Terraform',
          baseUrl: 'https://tf.example/api',
          auth: { type: 'none' },
          provision: { method: 'POST', pathTemplate: '/apply' },
          response: {},
        },
      },
      secrets: {},
    })
    expect(view.provisionType).toBe('custom')
    expect(view.manifestId).toBe('terraform')
    expect(view.acceptsManifestId).toBe('terraform')
    const overrides = await svc.resolveOverrides('user-1', 'ws-1')
    expect(overrides[0]!.acceptsManifestId).toBe('terraform')
    expect(overrides[0]!.backendKind).toBe('manifest')
  })
})
