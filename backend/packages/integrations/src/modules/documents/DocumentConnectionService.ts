import type { Clock, GroupCacheHandle, LinkedDocumentRefreshOutcome } from '@cat-factory/kernel'
import type { DocumentConnectionRecord, DocumentConnectionRepository } from '@cat-factory/kernel'
import type { DocumentSourceRegistry } from '@cat-factory/kernel'
import type {
  DocumentConnection,
  DocumentCredentials,
  DocumentSourceDescriptor,
  DocumentSourceKind,
} from '@cat-factory/kernel'
import { ConflictError, ValidationError } from '@cat-factory/kernel'
import { requireWorkspace } from '@cat-factory/kernel'
import type { WorkspaceRepository } from '@cat-factory/kernel'

// DocumentConnectionService: owns the binding between a cat-factory workspace and an
// external document source. Connecting delegates credential validation to the source's
// provider, then stores the credential bag; the import path resolves it to authenticate.
// Credentials are never exposed back to clients — only the safe connection metadata
// (source, label, timestamp) is. Every source is workspace-scoped: a single sealed
// credential shared by everyone in the workspace.

/**
 * The renewal half of a source's OAuth grant, as this service consumes it: given a stored
 * connection, the fresher credential bag to store, or null when there is nothing to do.
 *
 * A narrow interface rather than the service itself so the dependency runs ONE way. The OAuth
 * service owns the protocol and knows nothing about the connection store; this service owns the
 * row and calls into the protocol. Handing it the whole service would close the loop, and the
 * only way out of that is a setter nobody can see is required.
 */
export interface DocumentOAuthRenewer {
  renewIfExpiring(record: DocumentConnectionRecord): Promise<DocumentCredentials | null>
}

export interface DocumentConnectionServiceDependencies {
  documentConnectionRepository: DocumentConnectionRepository
  registry: DocumentSourceRegistry
  workspaceRepository: WorkspaceRepository
  clock: Clock
  /**
   * Renews an OAuth-granted connection whose access token is at or past its expiry, on the one
   * seam every read resolves a credential through.
   *
   * HERE rather than at each reader, because there are four of them (import, search, the content
   * resolver, the dispatch-time refresher) and a reader that forgot would spend a dead token and
   * report a permanent source outage. Optional so the service stays unit-testable standalone and
   * so a deployment wiring no OAuth-capable source pays nothing.
   */
  oauthRenewer?: DocumentOAuthRenewer
  /**
   * The dispatch-time freshness cache, so connecting or disconnecting a source drops every
   * verdict that connection authorised. Optional only so the service stays unit-testable
   * standalone; a deployment that caches and does not invalidate would compare a run's documents
   * against a token fetched with a credential the workspace has since replaced.
   */
  versionCache?: GroupCacheHandle<LinkedDocumentRefreshOutcome>
}

function toConnection(record: DocumentConnectionRecord): DocumentConnection {
  return {
    source: record.source,
    label: record.label,
    connectedAt: record.createdAt,
  }
}

export class DocumentConnectionService {
  constructor(private readonly deps: DocumentConnectionServiceDependencies) {}

  /** The descriptors of every configured source (drives the connect UI). */
  listSources(): DocumentSourceDescriptor[] {
    return this.deps.registry.list().map((p) => p.descriptor)
  }

  /** Resolve a provider for a source or throw if that source isn't configured. */
  private requireProvider(source: DocumentSourceKind) {
    const provider = this.deps.registry.get(source)
    if (!provider) throw new ValidationError(`Unknown or unconfigured document source '${source}'`)
    return provider
  }

  /** Connect (or re-connect) a workspace to a source; the credential is shared by the workspace. */
  async connect(
    workspaceId: string,
    source: DocumentSourceKind,
    credentials: Record<string, string>,
  ): Promise<DocumentConnection> {
    await requireWorkspace(this.deps.workspaceRepository, workspaceId)
    const provider = this.requireProvider(source)
    const normalized = provider.normalizeConnection(credentials)

    const existing = await this.deps.documentConnectionRepository.getByWorkspace(
      workspaceId,
      source,
    )
    const record: DocumentConnectionRecord = {
      workspaceId,
      source,
      credentials: normalized.credentials,
      label: normalized.label,
      createdAt: existing?.createdAt ?? this.deps.clock.now(),
      deletedAt: null,
    }
    await this.deps.documentConnectionRepository.upsert(record)
    // The freshness verdicts cached for this workspace were reached with the credential this call
    // just replaced, so drop the whole group rather than guessing which documents it covered.
    await this.deps.versionCache?.invalidateGroup(workspaceId)
    return toConnection(record)
  }

  /**
   * Store an OAuth grant as the workspace's connection to a source.
   *
   * It bypasses `normalizeConnection` deliberately: that method validates what a HUMAN typed, and
   * the bag here was minted by the platform from a token response the authorization server
   * already authenticated. Running it would require every OAuth-capable provider to also accept
   * a credential shape it never reads.
   *
   * The bag REPLACES whatever was stored, personal access token included. A workspace that has
   * just granted an app is connected BY that grant, and leaving the typed credential beside it
   * would keep a token the operator believes they replaced alive as a silent fallback.
   */
  async connectWithOAuth(
    workspaceId: string,
    source: DocumentSourceKind,
    credentials: DocumentCredentials,
  ): Promise<DocumentConnection> {
    await requireWorkspace(this.deps.workspaceRepository, workspaceId)
    const provider = this.requireProvider(source)
    const existing = await this.deps.documentConnectionRepository.getByWorkspace(
      workspaceId,
      source,
    )
    const record: DocumentConnectionRecord = {
      workspaceId,
      source,
      credentials,
      label: provider.descriptor.label,
      createdAt: existing?.createdAt ?? this.deps.clock.now(),
      deletedAt: null,
    }
    await this.deps.documentConnectionRepository.upsert(record)
    // Same reason as `connect`: every cached verdict for this workspace was reached through the
    // credential this call just replaced.
    await this.deps.versionCache?.invalidateGroup(workspaceId)
    return toConnection(record)
  }

  /** The current connection for a source, or null if not connected. */
  async getConnection(
    workspaceId: string,
    source: DocumentSourceKind,
  ): Promise<DocumentConnection | null> {
    const record = await this.resolveConnection(workspaceId, source)
    return record ? toConnection(record) : null
  }

  /**
   * The live connection record (WITH credentials) for a source, or null when the workspace has
   * none. The non-throwing twin of {@link requireConnection}, and the one place the stored row ⊕
   * implicit-connection resolution lives.
   *
   * Exists because a caller that must tell "no connection" from "the read itself failed" cannot do
   * it through a thrown `ConflictError` without also catching every transport fault as the same
   * fact (`LinkedDocumentRefreshService` reports those as two different gaps, needing two different
   * fixes). Returning the RECORD rather than the safe projection means such a caller resolves the
   * credential once instead of asking again through `requireConnection`.
   */
  async resolveConnection(
    workspaceId: string,
    source: DocumentSourceKind,
  ): Promise<DocumentConnectionRecord | null> {
    const record = await this.deps.documentConnectionRepository.getByWorkspace(workspaceId, source)
    if (record) return this.renewed(record)
    return this.resolveImplicit(workspaceId, source)
  }

  /**
   * Renew an OAuth-granted record whose access token is spent, persisting the result.
   *
   * Best-effort by construction: the renewer answers null for everything from "not an OAuth
   * connection" to "the refresh call failed", and the stored record is what a null means. A read
   * must never fail because a renewal could not be made; it fails on the source call that
   * follows, where it is reported as the outage it looks like.
   */
  private async renewed(record: DocumentConnectionRecord): Promise<DocumentConnectionRecord> {
    const credentials = await this.deps.oauthRenewer?.renewIfExpiring(record)
    if (!credentials) return record
    const renewed = { ...record, credentials }
    await this.deps.documentConnectionRepository.upsert(renewed)
    return renewed
  }

  /**
   * {@link resolveConnection} for SEVERAL sources in one stored-row read.
   *
   * The batch shape exists for the dispatch-time refresh, which asks about a whole corpus on every
   * step of every run: resolving per document (or even per document per source) is the N+1 this
   * repo bans, and the connection is invariant per `(workspace, source)` for the entire pass. Only
   * a source with NO stored row falls through to its provider's implicit resolution, which is an
   * out-of-band credential the provider owns and so has nothing to batch.
   */
  async resolveConnections(
    workspaceId: string,
    sources: readonly DocumentSourceKind[],
  ): Promise<Map<DocumentSourceKind, DocumentConnectionRecord | null>> {
    const wanted = new Set(sources)
    const resolved = new Map<DocumentSourceKind, DocumentConnectionRecord | null>()
    if (wanted.size === 0) return resolved
    const stored = await this.deps.documentConnectionRepository.listByWorkspace(workspaceId)
    // The renewals run together rather than in the loop: this pass runs per step of every run,
    // and at most one source's grant is ever due at a time, so a sequential await would put a
    // token round trip in front of the whole corpus for the sake of one document.
    await Promise.all(
      stored
        .filter((record) => wanted.has(record.source))
        .map(async (record) => {
          resolved.set(record.source, await this.renewed(record))
        }),
    )
    await Promise.all(
      [...wanted]
        .filter((source) => !resolved.has(source))
        .map(async (source) => {
          resolved.set(source, await this.resolveImplicit(workspaceId, source))
        }),
    )
    return resolved
  }

  /**
   * Every live connection the workspace holds, across sources — the stored
   * (credentialed) connections PLUS any source that is implicitly connected via an
   * out-of-band credential (GitHub docs on the workspace's installed App). A stored
   * row always wins, so an explicitly-connected source is never duplicated.
   */
  async listConnections(workspaceId: string): Promise<DocumentConnection[]> {
    const records = await this.deps.documentConnectionRepository.listByWorkspace(workspaceId)
    const connectedSources = new Set(records.map((r) => r.source))
    const connections = records.map(toConnection)
    for (const provider of this.deps.registry.list()) {
      if (connectedSources.has(provider.kind) || !provider.resolveImplicitConnection) continue
      const implicit = await provider.resolveImplicitConnection(workspaceId)
      if (implicit) {
        connections.push({
          source: provider.kind,
          label: implicit.label,
          connectedAt: this.deps.clock.now(),
        })
      }
    }
    return connections
  }

  /** Resolve the live connection (with credentials), or throw if not connected. */
  async requireConnection(
    workspaceId: string,
    source: DocumentSourceKind,
  ): Promise<DocumentConnectionRecord> {
    const record = await this.resolveConnection(workspaceId, source)
    if (record) return record
    throw new ConflictError(`Workspace '${workspaceId}' is not connected to ${source}`)
  }

  /**
   * Build a synthetic connection record for a source that is implicitly connected
   * via an out-of-band credential (the GitHub App), or null when it is not. Lets the
   * import / search / content-resolver paths treat an App-backed source as connected
   * without a stored marker row — the provider owns the credential resolution.
   */
  private async resolveImplicit(
    workspaceId: string,
    source: DocumentSourceKind,
  ): Promise<DocumentConnectionRecord | null> {
    const provider = this.deps.registry.get(source)
    if (!provider?.resolveImplicitConnection) return null
    const normalized = await provider.resolveImplicitConnection(workspaceId)
    if (!normalized) return null
    return {
      workspaceId,
      source,
      credentials: normalized.credentials,
      label: normalized.label,
      createdAt: this.deps.clock.now(),
      deletedAt: null,
    }
  }

  /** Disconnect a source (tombstones the binding). */
  async disconnect(workspaceId: string, source: DocumentSourceKind): Promise<void> {
    const record = await this.deps.documentConnectionRepository.getByWorkspace(workspaceId, source)
    if (!record) return
    await this.deps.documentConnectionRepository.softDelete(
      workspaceId,
      source,
      this.deps.clock.now(),
    )
    // Same reason as `connect`: every cached verdict for this workspace was reached through a
    // credential that no longer exists, and the next dispatch must find that out rather than
    // report `confirmed` against a source it can no longer reach.
    await this.deps.versionCache?.invalidateGroup(workspaceId)
  }
}
