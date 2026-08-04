import type {
  Clock,
  GitHubInstallation,
  GitHubInstallationRepository,
  SecretCipher,
  VcsIdentity,
  VcsIdentityResolver,
  WorkspaceRepository,
} from '@cat-factory/kernel'
import { ValidationError, VcsIdentityError } from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import { VcsPatConnectionService } from './VcsPatConnectionService.js'
import { syntheticInstallationId } from './syntheticInstallationId.js'

// A minimal in-memory installation store keyed by installation id, with the workspace lookup the
// service relies on (direct binding only — no account sharing, which is what the service expects
// for a per-workspace token).
function fakeInstallations(seed: GitHubInstallation[] = []): GitHubInstallationRepository & {
  rows: Map<number, GitHubInstallation>
} {
  const rows = new Map<number, GitHubInstallation>(seed.map((r) => [r.installationId, r]))
  return {
    rows,
    getByInstallationId: async (id) => rows.get(id) ?? null,
    listByInstallationIds: async (ids) => ids.map((id) => rows.get(id)).filter((r) => r != null),
    getByWorkspace: async (ws) =>
      [...rows.values()].find((r) => r.workspaceId === ws && !r.deletedAt) ?? null,
    listWorkspacesForInstallation: async () => [],
    listActive: async () => [...rows.values()].filter((r) => !r.deletedAt),
    listActiveForAccount: async (accountId: string) =>
      [...rows.values()].filter((r) => !r.deletedAt && r.accountId === accountId),
    upsert: async (i) => void rows.set(i.installationId, i),
    updateCachedToken: async () => {},
    softDelete: async (id, at) => {
      const row = rows.get(id)
      if (row) rows.set(id, { ...row, deletedAt: at })
    },
  }
}

const identity: VcsIdentity = {
  provider: 'gitlab',
  externalId: '42',
  login: 'octocat',
  name: 'Octo Cat',
  avatarUrl: null,
  email: null,
}

function fakeResolver(result: VcsIdentity | Error = identity): VcsIdentityResolver {
  return {
    resolveIdentity: async () => {
      if (result instanceof Error) throw result
      return result
    },
  }
}

// A trivial reversible cipher — enough to assert the token is sealed (not stored raw) and that a
// separate token source could recover it.
const cipher: SecretCipher = {
  encrypt: async (plaintext) => `sealed(${plaintext})`,
  decrypt: async (envelope) => envelope.replace(/^sealed\(|\)$/g, ''),
}

const workspaceRepository = {
  get: async (id: string) => ({ id }) as never,
} as unknown as WorkspaceRepository

function makeService(
  installations = fakeInstallations(),
  resolver = fakeResolver(),
  now = 1000,
): { service: VcsPatConnectionService; installations: ReturnType<typeof fakeInstallations> } {
  const clock: Clock = { now: () => now }
  const service = new VcsPatConnectionService({
    provider: 'gitlab',
    installations,
    workspaceRepository,
    identityResolver: resolver,
    cipher,
    clock,
  })
  return { service, installations }
}

describe('VcsPatConnectionService', () => {
  it('connects: validates the PAT, seals it, and writes a gitlab installation row', async () => {
    const { service, installations } = makeService()
    const connection = await service.connect('ws-1', 'glpat-secret')

    const expectedId = await syntheticInstallationId('ws-1')
    expect(connection.installationId).toBe(expectedId)
    expect(connection.provider).toBe('gitlab')
    // A pasted token, stated as such: the SPA drops every GitHub-App affordance (the
    // installation settings page, the repo-access grant) on a `pat` connection, and it must
    // not have to infer that from the provider.
    expect(connection.method).toBe('pat')
    expect(connection.accountLogin).toBe('octocat')
    expect(connection.connectedAt).toBe(1000)

    const row = installations.rows.get(expectedId)!
    expect(row.provider).toBe('gitlab')
    // The stored credential is the sealed envelope (what the cipher produced), never persisted raw.
    expect(row.accessToken).toBe('sealed(glpat-secret)')
    // Per-workspace token: no account-level sharing.
    expect(row.accountId).toBeNull()
    expect(row.workspaceId).toBe('ws-1')
  })

  it('rejects an invalid PAT (provider 4xx) with a ValidationError and writes nothing', async () => {
    const { service, installations } = makeService(
      fakeInstallations(),
      fakeResolver(new VcsIdentityError('HTTP 401', 401)),
    )
    await expect(service.connect('ws-1', 'bad')).rejects.toBeInstanceOf(ValidationError)
    expect(installations.rows.size).toBe(0)
  })

  it('propagates a transient upstream failure verbatim (NOT a ValidationError) and writes nothing', async () => {
    // A provider 5xx or a transport failure is the provider's fault, not the token's — mapping it
    // to "invalid token" would mislead the user and discard the real cause. It must surface as-is
    // (→ a 500), never as a 4xx validation error.
    for (const err of [new VcsIdentityError('HTTP 503', 503), new Error('network unreachable')]) {
      const { service, installations } = makeService(fakeInstallations(), fakeResolver(err))
      await expect(service.connect('ws-1', 'tok')).rejects.toBe(err)
      expect(installations.rows.size).toBe(0)
    }
  })

  it('getConnection returns the gitlab connection, and null for other providers / none', async () => {
    const { service } = makeService()
    expect(await service.getConnection('ws-1')).toBeNull()
    await service.connect('ws-1', 'glpat-secret')
    expect((await service.getConnection('ws-1'))?.provider).toBe('gitlab')

    // A github installation for another workspace must not surface through the gitlab service.
    const id = await syntheticInstallationId('ws-2')
    const withGithub = fakeInstallations([
      {
        installationId: id,
        workspaceId: 'ws-2',
        accountId: null,
        accountLogin: 'gh',
        targetType: 'User',
        appId: null,
        provider: 'github',
        cachedToken: null,
        tokenExpiresAt: null,
        accessToken: null,
        createdAt: 1,
        deletedAt: null,
      },
    ])
    const { service: svc2 } = makeService(withGithub)
    expect(await svc2.getConnection('ws-2')).toBeNull()
  })

  it('re-connecting preserves the original connectedAt while replacing the sealed token', async () => {
    const installations = fakeInstallations()
    const first = makeService(installations, fakeResolver(), 1000)
    await first.service.connect('ws-1', 'glpat-one')

    const second = makeService(installations, fakeResolver(), 5000)
    const reconnected = await second.service.connect('ws-1', 'glpat-two')

    expect(reconnected.connectedAt).toBe(1000) // preserved
    const id = await syntheticInstallationId('ws-1')
    expect(installations.rows.get(id)!.accessToken).toBe('sealed(glpat-two)') // replaced
  })

  it('disconnect tombstones the gitlab binding', async () => {
    const { service, installations } = makeService()
    await service.connect('ws-1', 'glpat-secret')
    await service.disconnect('ws-1')
    const id = await syntheticInstallationId('ws-1')
    expect(installations.rows.get(id)!.deletedAt).toBe(1000)
    expect(await service.getConnection('ws-1')).toBeNull()
  })
})
