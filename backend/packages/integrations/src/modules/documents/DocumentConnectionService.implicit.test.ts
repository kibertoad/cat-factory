import { describe, expect, it } from 'vitest'
import type {
  Clock,
  DocumentConnectionRecord,
  DocumentConnectionStore,
  DocumentSourceProvider,
  DocumentSourceRegistry,
  NormalizedConnection,
  WorkspaceRepository,
} from '@cat-factory/kernel'
import { ConflictError } from '@cat-factory/kernel'
import { DocumentConnectionService } from './DocumentConnectionService.js'

// Focused coverage of the implicit-connection resolution: a source that rides an
// out-of-band credential (GitHub docs on the installed App) surfaces as connected —
// in listConnections / getConnection / requireConnection — WITHOUT a stored marker
// row, so it is available as a document source the moment the App is installed. A
// stored (credentialed) connection always wins and is never duplicated.

function makeService(opts: {
  stored?: DocumentConnectionRecord[]
  /** Whether the GitHub-docs provider reports an implicit connection for the workspace. */
  githubInstalled: boolean
}) {
  const store = new Map<string, DocumentConnectionRecord>()
  for (const r of opts.stored ?? []) store.set(r.source, r)
  const reads = { byWorkspace: 0, listed: 0 }
  const invalidatedGroups: string[] = []
  // Faked at the STORE level: these cases are about the service's stored-⊕-implicit resolution,
  // and the sealing itself has its own unit test (`sealedConnectionStore.test.ts`).
  const documentConnectionStore: DocumentConnectionStore = {
    async getByWorkspace(_ws, source) {
      reads.byWorkspace += 1
      return store.get(source) ?? null
    },
    async listBySources(_ws, sources) {
      reads.listed += 1
      return sources.map((source) => store.get(source)).filter((row) => row !== undefined)
    },
    async listSummaries() {
      reads.listed += 1
      return [...store.values()].map(({ workspaceId, source, label, createdAt }) => ({
        workspaceId,
        source,
        label,
        createdAt,
      }))
    },
    async upsert(record) {
      store.set(record.source, record)
    },
    async softDelete(_ws, source) {
      store.delete(source)
    },
  }

  // A credentialed source (Confluence) with no implicit path.
  const confluence: Partial<DocumentSourceProvider> = {
    kind: 'confluence',
    normalizeConnection: (): NormalizedConnection => ({ credentials: {}, label: 'Confluence' }),
  }
  // The GitHub-docs provider: implicitly connected iff the App is installed.
  const github: Partial<DocumentSourceProvider> = {
    kind: 'github',
    normalizeConnection: (): NormalizedConnection => ({ credentials: {}, label: 'GitHub' }),
    resolveImplicitConnection: async () =>
      opts.githubInstalled ? { credentials: {}, label: 'GitHub' } : null,
  }
  const providers = [confluence as DocumentSourceProvider, github as DocumentSourceProvider]
  const registry: DocumentSourceRegistry = {
    get: (kind) => providers.find((p) => p.kind === kind),
    list: () => providers,
  }
  const workspaceRepository = {
    get: async () => ({ id: 'ws_1' }),
  } as unknown as WorkspaceRepository
  const clock: Clock = { now: () => 1000 }

  const service = new DocumentConnectionService({
    documentConnectionStore,
    registry,
    workspaceRepository,
    clock,
    versionCache: {
      get: async (_key, _group, load) => load(),
      invalidate: async () => {},
      invalidateGroup: async (group) => {
        invalidatedGroups.push(group)
      },
      invalidateAll: async () => {},
    },
  })
  return Object.assign(service, {
    reads,
    invalidatedGroups,
  })
}

describe('DocumentConnectionService implicit connections', () => {
  it('surfaces GitHub as connected once the App is installed, with no stored row', async () => {
    const service = makeService({ githubInstalled: true })

    const list = await service.listConnections('ws_1')
    expect(list.map((c) => c.source)).toEqual(['github'])

    expect(await service.getConnection('ws_1', 'github')).not.toBeNull()
    const record = await service.requireConnection('ws_1', 'github')
    expect(record.source).toBe('github')
    expect(record.credentials).toEqual({})
  })

  it('does not surface GitHub when the App is not installed', async () => {
    const service = makeService({ githubInstalled: false })

    expect(await service.listConnections('ws_1')).toEqual([])
    expect(await service.getConnection('ws_1', 'github')).toBeNull()
    await expect(service.requireConnection('ws_1', 'github')).rejects.toBeInstanceOf(ConflictError)
  })

  it('does not synthesize an implicit connection for a credentialed source', async () => {
    const service = makeService({ githubInstalled: false })
    expect(await service.getConnection('ws_1', 'confluence')).toBeNull()
    await expect(service.requireConnection('ws_1', 'confluence')).rejects.toBeInstanceOf(
      ConflictError,
    )
  })

  it('a stored connection wins and is never duplicated by the implicit one', async () => {
    const stored: DocumentConnectionRecord = {
      workspaceId: 'ws_1',
      source: 'github',
      credentials: { token: 'explicit' },
      label: 'GitHub (explicit)',
      createdAt: 42,
      deletedAt: null,
    }
    const service = makeService({ githubInstalled: true, stored: [stored] })

    const list = await service.listConnections('ws_1')
    expect(list.filter((c) => c.source === 'github')).toHaveLength(1)
    expect(list[0]?.label).toBe('GitHub (explicit)')
    // requireConnection returns the stored (credential-bearing) row, not the implicit marker.
    const record = await service.requireConnection('ws_1', 'github')
    expect(record.credentials).toEqual({ token: 'explicit' })
  })
})

describe('DocumentConnectionService batch resolution', () => {
  it('resolves several sources in ONE stored-row read', async () => {
    // The dispatch-time refresh asks about a whole corpus on every step of every run: a read per
    // document (or per document per source) is the N+1 this repo bans, and the connection is
    // invariant per (workspace, source) for the entire pass.
    const stored: DocumentConnectionRecord = {
      workspaceId: 'ws_1',
      source: 'confluence',
      credentials: { token: 'c' },
      label: 'Confluence',
      createdAt: 1,
      deletedAt: null,
    }
    const service = makeService({ githubInstalled: true, stored: [stored] })

    const resolved = await service.resolveConnections('ws_1', ['confluence', 'github'])

    expect(service.reads.listed).toBe(1)
    expect(service.reads.byWorkspace).toBe(0)
    expect(resolved.get('confluence')?.credentials).toEqual({ token: 'c' })
    // Only a source with no stored row falls through to its provider's out-of-band credential.
    expect(resolved.get('github')?.label).toBe('GitHub')
  })

  it('reads nothing at all for an empty source list', async () => {
    const service = makeService({ githubInstalled: true })

    expect(await service.resolveConnections('ws_1', [])).toEqual(new Map())
    expect(service.reads.listed).toBe(0)
  })

  it('answers null for a source the workspace is not connected to, rather than throwing', async () => {
    // The non-throwing twin exists because a caller that must tell "no connection" from "the read
    // itself failed" cannot do it through a thrown ConflictError without catching every transport
    // fault as the same fact: two gaps that need two different fixes.
    const service = makeService({ githubInstalled: false })

    const resolved = await service.resolveConnections('ws_1', ['confluence'])

    expect(resolved.get('confluence')).toBeNull()
  })
})

describe('DocumentConnectionService cache coherence', () => {
  it('drops every cached freshness verdict for the workspace on connect', async () => {
    // Those verdicts were reached with the credential this write just replaced. The TTL bounds how
    // long a run dispatches against an unnoticed edit; only invalidation keeps a verdict from
    // outliving the write that made it wrong.
    const service = makeService({ githubInstalled: false })

    await service.connect('ws_1', 'confluence', {})

    expect(service.invalidatedGroups).toEqual(['ws_1'])
  })

  it('drops them on disconnect too', async () => {
    const stored: DocumentConnectionRecord = {
      workspaceId: 'ws_1',
      source: 'confluence',
      credentials: {},
      label: 'Confluence',
      createdAt: 1,
      deletedAt: null,
    }
    const service = makeService({ githubInstalled: false, stored: [stored] })

    await service.disconnect('ws_1', 'confluence')

    expect(service.invalidatedGroups).toEqual(['ws_1'])
  })
})
