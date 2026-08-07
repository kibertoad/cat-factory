import { createAppCaches } from '@cat-factory/caching'
import type {
  Clock,
  DeploymentDocumentResolver,
  DocumentContent,
  DocumentSourceKind,
  FragmentOwnerKind,
  PromptFragmentRecord,
  PromptFragmentRepository,
  WorkspaceRepository,
} from '@cat-factory/kernel'
import { DEPLOYMENT_DOCUMENT_CACHE_GROUP, createRecordingLogger } from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import { FragmentLibraryService } from './FragmentLibraryService.js'

// A code-registered (`builtin`-tier) fragment may name a LIVING document, resolved with credentials
// the DEPLOYMENT configured rather than any tenant's connection.
//
// What these pin is the property the feature exists for and the one a reader cannot see from a
// prompt: a deployment-wide document is fetched ONCE and cached under ONE group however many
// workspaces fold it. The old behaviour (serve the registered body, silently) and the new one are
// byte-identical in the prompt, so only a test over the resolver's call log can tell them apart.

class RecordingDeploymentDocuments implements DeploymentDocumentResolver {
  fetches: string[] = []
  probes: string[] = []
  version = 'v1'
  body = 'LIVE BODY'
  failWith: Error | null = null

  constructor(private readonly sources: DocumentSourceKind[] = ['notion']) {}

  configured(source: DocumentSourceKind): boolean {
    return this.sources.includes(source)
  }
  async fetch(source: DocumentSourceKind, externalId: string): Promise<DocumentContent> {
    this.fetches.push(`${source}:${externalId}`)
    if (this.failWith) throw this.failWith
    return {
      externalId,
      title: 'Doc',
      url: 'https://x.test/doc',
      body: this.body,
      version: this.version,
    }
  }
  async probeVersion(source: DocumentSourceKind, externalId: string): Promise<string> {
    this.probes.push(`${source}:${externalId}`)
    if (this.failWith) throw this.failWith
    return this.version
  }
}

class EmptyFragmentRepo implements PromptFragmentRepository {
  async listByOwner(_kind: FragmentOwnerKind, _id: string): Promise<PromptFragmentRecord[]> {
    return []
  }
  async get() {
    return null
  }
  async upsert() {}
  async softDelete() {}
  async listBySource() {
    return []
  }
}

const clock: Clock = { now: () => 1_000_000 }

/** The registered fragment under test: a deployment standard whose body lives in Notion. */
const LIVE_STANDARD = {
  id: 'org.api-guidelines',
  version: '1.0.0',
  title: 'Org API guidelines',
  category: 'Org',
  summary: 'How this org shapes APIs.',
  body: 'REGISTERED BODY',
  documentRef: { source: 'notion' as const, externalId: 'page-1' },
}

function makeService(
  deploymentDocuments?: DeploymentDocumentResolver,
  logger = createRecordingLogger(),
) {
  const service = new FragmentLibraryService({
    promptFragmentRepository: new EmptyFragmentRepo(),
    workspaceRepository: { accountOf: async () => null } as unknown as WorkspaceRepository,
    clock,
    logger,
    builtins: [LIVE_STANDARD],
    documentBodyCache: createAppCaches().fragmentDocumentBody,
    ...(deploymentDocuments ? { deploymentDocumentResolver: deploymentDocuments } : {}),
  })
  return { service, logger }
}

async function bodyFor(service: FragmentLibraryService, workspaceId: string): Promise<string> {
  const resolved = await service.resolveBodiesForRun(workspaceId, [LIVE_STANDARD.id])
  return resolved[0]?.body ?? ''
}

describe('a code-registered fragment with a documentRef', () => {
  it('folds the LIVE body when the deployment can resolve its source', async () => {
    const documents = new RecordingDeploymentDocuments()
    const { service } = makeService(documents)

    expect(await bodyFor(service, 'ws1')).toBe('LIVE BODY')
    expect(documents.fetches).toEqual(['notion:page-1'])
  })

  it('fetches ONCE for the whole deployment, not once per workspace', async () => {
    // The reason the group is `DEPLOYMENT_DOCUMENT_CACHE_GROUP` rather than the run's workspace.
    // Keyed per workspace this document would be fetched N times and a later edit could never
    // invalidate all of them, which is exactly the fan-out the account tier's `docViaWorkspaceId`
    // rule already refuses. Three workspaces, one fetch.
    const documents = new RecordingDeploymentDocuments()
    const { service } = makeService(documents)

    for (const ws of ['ws1', 'ws2', 'ws3']) expect(await bodyFor(service, ws)).toBe('LIVE BODY')
    expect(documents.fetches).toEqual(['notion:page-1'])
  })

  it('invalidating the deployment group re-resolves it for every workspace at once', async () => {
    // The other half of one group: ONE invalidation reaches every reader. A per-workspace group
    // would need N, and nothing knows what N is.
    const documents = new RecordingDeploymentDocuments()
    const caches = createAppCaches()
    const service = new FragmentLibraryService({
      promptFragmentRepository: new EmptyFragmentRepo(),
      workspaceRepository: { accountOf: async () => null } as unknown as WorkspaceRepository,
      clock,
      builtins: [LIVE_STANDARD],
      documentBodyCache: caches.fragmentDocumentBody,
      deploymentDocumentResolver: documents,
    })

    expect(await bodyFor(service, 'ws1')).toBe('LIVE BODY')
    await bodyFor(service, 'ws2')
    expect(documents.fetches).toHaveLength(1)

    documents.body = 'EDITED BODY'
    await caches.fragmentDocumentBody.invalidateGroup(DEPLOYMENT_DOCUMENT_CACHE_GROUP)

    expect(await bodyFor(service, 'ws1')).toBe('EDITED BODY')
    expect(await bodyFor(service, 'ws2')).toBe('EDITED BODY')
  })

  it('degrades to the REGISTERED body and SAYS SO when the source is unreachable', async () => {
    // Degrading is right: an unreachable vendor must not wedge a run. Degrading SILENTLY is what
    // makes a stale standard indistinguishable from a current one, because the prompt is
    // byte-identical either way and nothing downstream can tell.
    const documents = new RecordingDeploymentDocuments()
    documents.failWith = new Error('notion is down')
    const { service, logger } = makeService(documents)

    expect(await bodyFor(service, 'ws1')).toBe('REGISTERED BODY')
    const warning = logger.lines.find((r) => r.level === 'warn' && r.fields?.fragmentId)
    expect(warning?.fields).toMatchObject({ fragmentId: LIVE_STANDARD.id, source: 'notion' })
  })

  it('serves the registered body when the deployment configured no resolver at all', async () => {
    // The unconfigured deployment. Boot validation refuses this registration, so a run only reaches
    // here on a deployment that ignored the refusal; the fallback must still be the registered body
    // rather than an empty standard.
    const { service } = makeService(undefined)
    expect(await bodyFor(service, 'ws1')).toBe('REGISTERED BODY')
  })

  it('serves the registered body when the resolver cannot serve THAT source', async () => {
    // A deployment that configured Confluence but whose fragment names Notion. Asking `configured`
    // before fetching is what keeps this from being a failed round trip per run.
    const documents = new RecordingDeploymentDocuments(['confluence'])
    const { service } = makeService(documents)

    expect(await bodyFor(service, 'ws1')).toBe('REGISTERED BODY')
    expect(documents.fetches).toEqual([])
  })
})
