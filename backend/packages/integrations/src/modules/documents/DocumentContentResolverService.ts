import type {
  DocumentContent,
  DocumentContentResolver,
  DocumentCredentials,
  DocumentSourceKind,
  DocumentSourceProvider,
  DocumentSourceRegistry,
} from '@cat-factory/kernel'
import { ValidationError } from '@cat-factory/kernel'
import type { DocumentConnectionService } from './DocumentConnectionService.js'

// DocumentContentResolverService: the runtime read seam ({@link DocumentContentResolver})
// for living document-backed prompt fragments. It resolves a workspace's stored
// connection and fetches the page's current content via the source provider —
// the same fetch the import path does, but WITHOUT persisting a `documents`
// projection row (a fragment owns its own cached body + freshness, so there is no
// document/block linkage to keep). Throws when the source is unconfigured or the
// workspace is not connected, so the caller can decide to fall back to the
// last-resolved body rather than wedge a run.

export interface DocumentContentResolverServiceDependencies {
  registry: DocumentSourceRegistry
  connectionService: DocumentConnectionService
}

export class DocumentContentResolverService implements DocumentContentResolver {
  constructor(private readonly deps: DocumentContentResolverServiceDependencies) {}

  async fetch(
    workspaceId: string,
    source: DocumentSourceKind,
    externalId: string,
  ): Promise<DocumentContent> {
    const { provider, credentials } = await this.resolve(workspaceId, source)
    return provider.fetchDocument(credentials, externalId)
  }

  async probeVersion(
    workspaceId: string,
    source: DocumentSourceKind,
    externalId: string,
  ): Promise<string> {
    const { provider, credentials } = await this.resolve(workspaceId, source)
    return provider.probeVersion(credentials, externalId)
  }

  /** Resolve the provider + this workspace's connection credentials for a source. */
  private async resolve(
    workspaceId: string,
    source: DocumentSourceKind,
  ): Promise<{ provider: DocumentSourceProvider; credentials: DocumentCredentials }> {
    const provider = this.deps.registry.get(source)
    if (!provider) {
      throw new ValidationError(`Unknown or unconfigured document source '${source}'`)
    }
    const connection = await this.deps.connectionService.requireConnection(workspaceId, source)
    return { provider, credentials: connection.credentials }
  }
}
