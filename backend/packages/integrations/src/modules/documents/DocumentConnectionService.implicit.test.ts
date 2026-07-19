import { describe, expect, it } from 'vitest'
import type {
  Clock,
  DocumentConnectionRecord,
  DocumentConnectionRepository,
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
  const documentConnectionRepository: DocumentConnectionRepository = {
    async getByWorkspace(_ws, source) {
      return store.get(source) ?? null
    },
    async listByWorkspace() {
      return [...store.values()]
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

  return new DocumentConnectionService({
    documentConnectionRepository,
    registry,
    workspaceRepository,
    clock,
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
