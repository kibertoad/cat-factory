import { defineStore } from 'pinia'
import { ref } from 'vue'
import type {
  DocKind,
  DocumentBoardPlan,
  DocumentConnection,
  DocumentLinkRole,
  DocumentSearchResult,
  DocumentSourceDescriptor,
  DocumentSourceKind,
  SourceDocument,
} from '~/types/domain'
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

  // Shared opt-in / probe / connections lifecycle (see `useSourceIntegration`).
  const integration = useSourceIntegration<
    DocumentSourceKind,
    DocumentConnection,
    DocumentSourceDescriptor
  >({
    enabled: () => !!workspace.workspaceId,
    workspaceId: () => workspace.workspaceId,
    fetch: async () => {
      const [{ sources }, { connections }] = await Promise.all([
        api.listDocumentSources(workspace.requireId()),
        api.listDocumentConnections(workspace.requireId()),
      ])
      return { sources, connections }
    },
  })
  const { available, sources, connections, connectedSources, anyConnected } = integration
  const { descriptorFor, connectionFor, isConnected, probe, ensureProbed } = integration

  const { items: documents, upsert: upsertDoc } = useUpsertList<SourceDocument>({
    key: (d) => `${d.source}:${d.externalId}`,
    prepend: true,
  })
  const loading = ref(false)

  // Workspace+DocKind template / exemplar role links (WS1). Loaded lazily when the management
  // panel opens; the full list of role-tagged documents across kinds.
  const roleLinks = ref<SourceDocument[]>([])

  /** Imported documents currently attached to a given block. */
  function docsForBlock(blockId: string): SourceDocument[] {
    return documents.value.filter((d) => d.linkedBlockId === blockId)
  }

  /** Connect the workspace to a source with its credential bag. */
  async function connect(source: DocumentSourceKind, credentials: Record<string, string>) {
    const conn = await api.connectDocumentSource(workspace.requireId(), source, credentials)
    integration.upsertConnection(conn)
    available.value = true
  }

  /** Disconnect the workspace from a source. */
  async function disconnect(source: DocumentSourceKind) {
    await api.disconnectDocumentSource(workspace.requireId(), source)
    integration.removeConnection(source)
  }

  /** Load the imported documents for the workspace (across sources). */
  async function loadDocuments() {
    documents.value = await api.listDocuments(workspace.requireId())
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

  /** Preview the board structure a page would expand into (no writes). */
  function plan(source: DocumentSourceKind, externalId: string): Promise<DocumentBoardPlan> {
    return api.planDocument(workspace.requireId(), source, externalId)
  }

  /** Apply a page's structure to the board, then refresh the board snapshot. */
  async function spawn(source: DocumentSourceKind, externalId: string, frameId?: string) {
    const { result } = await api.spawnDocument(workspace.requireId(), source, {
      externalId,
      frameId,
    })
    await workspace.refresh()
    return result
  }

  /** Attach an imported page to a block as agent context. */
  async function linkToBlock(blockId: string, source: DocumentSourceKind, externalId: string) {
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
    source: DocumentSourceKind,
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
  async function unlinkForKind(source: DocumentSourceKind, externalId: string) {
    await api.unlinkDocumentForKind(workspace.requireId(), { source, externalId })
    roleLinks.value = roleLinks.value.filter(
      (d) => !(d.source === source && d.externalId === externalId),
    )
  }

  return {
    available,
    sources,
    connections,
    documents,
    loading,
    connectedSources,
    anyConnected,
    descriptorFor,
    connectionFor,
    isConnected,
    docsForBlock,
    probe,
    ensureProbed,
    connect,
    disconnect,
    loadDocuments,
    importDocument,
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
