import { defineStore } from 'pinia'
import { ref } from 'vue'
import type {
  DocKind,
  DocumentBoardPlan,
  DocumentConnection,
  DocumentLinkRole,
  DocumentSearchResult,
  DocumentOrigin,
  DocumentSourceDescriptor,
  DocumentSourceKind,
  ResolvedDocumentRef,
  SourceDocument,
} from '~/types/domain'
import { isConnectableSource } from '@cat-factory/contracts'
import { useDocumentFreshness } from '~/composables/useDocumentFreshness'
import { useDocumentSourceConnect } from '~/composables/useDocumentSourceConnect'
import { useSourceIntegration } from '~/composables/useSourceIntegration'
import { useUpsertList } from '~/composables/useUpsertList'
import { useWorkspaceStore } from '~/stores/workspace'

/**
 * Document-source integration state: the sources the backend offers (and their
 * connect metadata), the workspace's per-source connections, and the pages it
 * has imported — plus the actions that connect/import/plan/spawn/link against the
 * backend. `available` mirrors the backend's opt-in gate: a 503 from the source
 * probe means the integration is off, and the UI hides its entry points (just as
 * `auth.required` gates the login UI). The abstraction is source-agnostic; every
 * action is keyed by a `DocumentSourceKind`. Per-workspace, like the board
 * itself; nothing is persisted client-side.
 */
export const useDocumentsStore = defineStore('documents', () => {
  const api = useApi()
  const workspace = useWorkspaceStore()

  // What this DEPLOYMENT can OAuth, reported beside the descriptors and read through
  // `useDocumentSourceConnect`, which owns why that is a separate fact from the descriptor's own.
  const oauthSources = ref<DocumentSourceKind[]>([])

  // Shared opt-in / probe / connections lifecycle (see `useSourceIntegration`).
  const integration = useSourceIntegration<
    DocumentSourceKind,
    DocumentConnection,
    DocumentSourceDescriptor
  >({
    enabled: () => !!workspace.workspaceId,
    workspaceId: () => workspace.workspaceId,
    fetch: async () => {
      const [{ sources, oauthSources: oauth }, { connections }] = await Promise.all([
        api.listDocumentSources(workspace.requireId()),
        api.listDocumentConnections(workspace.requireId()),
      ])
      oauthSources.value = oauth
      return { sources, connections }
    },
  })
  const { available, sources, connections, connectedSources, anyConnected } = integration
  const { descriptorFor, connectionFor, isConnected, probe, ensureProbed } = integration

  // Connecting a source, and what this board may connect it WITH, in its own collaborator: the
  // question grew several parts when OAuth landed, and none of the store's other concerns (the
  // imported documents, their freshness, the doc-kind role links) read any of them.
  const { canConnectWithOAuth, connectedDesignSources, connect, disconnect, beginOAuthConnect } =
    useDocumentSourceConnect({
      workspaceId: () => workspace.requireId(),
      oauthSources,
      connectedSources,
      onConnected: (conn) => {
        integration.upsertConnection(conn)
        available.value = true
      },
      onDisconnected: (source) => integration.removeConnection(source),
    })

  const { items: documents, upsert: upsertDoc } = useUpsertList<SourceDocument>({
    key: (d) => `${d.source}:${d.externalId}`,
    prepend: true,
  })
  const loading = ref(false)

  // The "is this still the current revision" half, in its own collaborator: a verdict is a
  // statement about a moment rather than a property of a row, and `useDocumentFreshness` owns why
  // the two must not merge.
  const { refresh, freshnessFor, isRefreshing } = useDocumentFreshness({
    workspaceId: () => workspace.workspaceId,
    refresh: (source, externalId) =>
      api.refreshDocument(workspace.requireId(), { source, externalId }),
    onRefreshed: upsertDoc,
  })

  // Workspace+DocKind template / exemplar role links (WS1). Loaded lazily when the management
  // panel opens; the full list of role-tagged documents across kinds.
  const roleLinks = ref<SourceDocument[]>([])

  /** Imported documents currently attached to a given block. */
  function docsForBlock(blockId: string): SourceDocument[] {
    return documents.value.filter((d) => d.linkedBlockId === blockId)
  }

  /** Load the imported documents for the workspace (across sources). */
  async function loadDocuments() {
    documents.value = await api.listDocuments(workspace.requireId())
  }

  /**
   * Canonicalise a pasted URL/id into the reference this source would store it under, WITHOUT
   * importing it. The backend's providers own the rule, so the picker validates against the same
   * parse the import will run rather than a second copy of it that can drift; a ref the source
   * cannot read comes back as a 422 whose `details.reason` says which correction it needs.
   */
  function resolveRef(source: DocumentSourceKind, ref: string): Promise<ResolvedDocumentRef> {
    return api.resolveDocumentRef(workspace.requireId(), source, { ref })
  }

  /** Import (fetch + persist) a page by id or URL from a source. */
  async function importDocument(source: DocumentSourceKind, ref: string): Promise<SourceDocument> {
    loading.value = true
    try {
      const doc = await api.importDocument(workspace.requireId(), source, { ref })
      upsertDoc(doc)
      return doc
    } finally {
      loading.value = false
    }
  }

  /** Search a connected source's catalogue by free text (title/content). */
  async function search(
    source: DocumentSourceKind,
    query: string,
  ): Promise<DocumentSearchResult[]> {
    const { results } = await api.searchDocumentSource(workspace.requireId(), source, query)
    return results
  }

  /**
   * Preview the board structure a page would expand into (no writes).
   *
   * With `frameId` the preview is TARGET-AWARE: the planner is told which service the work goes
   * inside and proposes its modules and tasks instead of an architecture.
   */
  function plan(
    source: DocumentSourceKind,
    externalId: string,
    frameId?: string,
  ): Promise<DocumentBoardPlan> {
    return api.planDocument(workspace.requireId(), source, {
      externalId,
      ...(frameId ? { frameId } : {}),
    })
  }

  /**
   * Apply a page's structure to the board, then refresh the board snapshot.
   *
   * `frameId` must be the SAME frame the preview was planned for. The endpoint re-plans against
   * it, so a targeted preview and its write agree; sending a frame the preview did not use would
   * flatten a board-wide plan into it and discard the frame titles and types the user approved,
   * which is why this was board-level only until target-aware planning existed.
   */
  async function spawn(source: DocumentSourceKind, externalId: string, frameId?: string) {
    const { result } = await api.spawnDocument(workspace.requireId(), source, {
      externalId,
      ...(frameId ? { frameId } : {}),
    })
    await workspace.refresh()
    return result
  }

  /**
   * The descriptor for a STORED document's origin, or undefined when it has none.
   *
   * `descriptorFor` is keyed by a connectable `DocumentSourceKind`, and a stored document's
   * origin is wider than that: an `upload` was handed to the platform through the API and has no
   * source behind it to describe. Narrowing through the predicate DERIVED from the source
   * picklist is what keeps that a typed absence rather than an `undefined` the caller trips over,
   * and what makes adding a source fail the build here until it is handled.
   */
  function descriptorForOrigin(origin: DocumentOrigin): DocumentSourceDescriptor | undefined {
    return isConnectableSource(origin) ? descriptorFor(origin) : undefined
  }

  /** Attach an imported page to a block as agent context. */
  async function linkToBlock(blockId: string, source: DocumentOrigin, externalId: string) {
    const doc = await api.linkDocument(workspace.requireId(), { source, externalId, blockId })
    upsertDoc(doc)
    return doc
  }

  // ---- workspace+DocKind template / exemplar links (WS1) ------------------

  /** Load every role-tagged (template/exemplar) document for the workspace. */
  async function loadRoleLinks() {
    roleLinks.value = await api.listDocumentRoleLinks(workspace.requireId())
  }

  /** The current template link for a kind (singular), if any. */
  function templateFor(docKind: DocKind): SourceDocument | undefined {
    return roleLinks.value.find((d) => d.role === 'template' && d.docKind === docKind)
  }

  /** The exemplar links for a kind (multi-valued). */
  function exemplarsFor(docKind: DocKind): SourceDocument[] {
    return roleLinks.value.filter((d) => d.role === 'exemplar' && d.docKind === docKind)
  }

  /**
   * Tag an imported document as the workspace's template (singular per kind) or exemplar for a
   * kind, then reconcile the local list (a template replaces the prior one for its kind).
   */
  async function linkForKind(
    source: DocumentOrigin,
    externalId: string,
    role: DocumentLinkRole,
    docKind: DocKind,
  ) {
    const doc = await api.linkDocumentForKind(workspace.requireId(), {
      source,
      externalId,
      role,
      docKind,
    })
    const key = (d: SourceDocument) => `${d.source}:${d.externalId}`
    // Drop any row for this doc, plus the prior template for this kind (singular replace).
    roleLinks.value = roleLinks.value.filter(
      (d) =>
        key(d) !== key(doc) &&
        !(role === 'template' && d.role === 'template' && d.docKind === docKind),
    )
    roleLinks.value.push(doc)
    return doc
  }

  /** Clear a document's role tag (built-in template resumes for the kind / exemplar drops). */
  async function unlinkForKind(source: DocumentOrigin, externalId: string) {
    await api.unlinkDocumentForKind(workspace.requireId(), { source, externalId })
    roleLinks.value = roleLinks.value.filter(
      (d) => !(d.source === source && d.externalId === externalId),
    )
  }

  return {
    available,
    sources,
    oauthSources,
    canConnectWithOAuth,
    connectedDesignSources,
    beginOAuthConnect,
    connections,
    documents,
    loading,
    connectedSources,
    anyConnected,
    descriptorFor,
    descriptorForOrigin,
    connectionFor,
    isConnected,
    docsForBlock,
    probe,
    ensureProbed,
    connect,
    disconnect,
    loadDocuments,
    resolveRef,
    importDocument,
    refresh,
    freshnessFor,
    isRefreshing,
    search,
    plan,
    spawn,
    linkToBlock,
    roleLinks,
    loadRoleLinks,
    templateFor,
    exemplarsFor,
    linkForKind,
    unlinkForKind,
  }
})
