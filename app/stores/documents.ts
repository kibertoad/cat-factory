import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type {
  DocumentBoardPlan,
  DocumentConnection,
  DocumentSourceDescriptor,
  DocumentSourceKind,
  SourceDocument,
} from '~/types/domain'
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

  /** null = unknown (not probed yet), true/false = integration on/off. */
  const available = ref<boolean | null>(null)
  /** The configured sources and their connect/import descriptors. */
  const sources = ref<DocumentSourceDescriptor[]>([])
  /** Live connections, one per connected source. */
  const connections = ref<DocumentConnection[]>([])
  const documents = ref<SourceDocument[]>([])
  const loading = ref(false)

  /** Sources the workspace currently has a live connection to. */
  const connectedSources = computed(() =>
    sources.value.filter((s) => connections.value.some((c) => c.source === s.source)),
  )
  const anyConnected = computed(() => connections.value.length > 0)

  function descriptorFor(source: DocumentSourceKind): DocumentSourceDescriptor | undefined {
    return sources.value.find((s) => s.source === source)
  }

  function connectionFor(source: DocumentSourceKind): DocumentConnection | undefined {
    return connections.value.find((c) => c.source === source)
  }

  function isConnected(source: DocumentSourceKind): boolean {
    return connectionFor(source) !== undefined
  }

  /** Imported documents currently attached to a given block. */
  function docsForBlock(blockId: string): SourceDocument[] {
    return documents.value.filter((d) => d.linkedBlockId === blockId)
  }

  /** Merge a document returned by the backend into the local cache. */
  function upsertDoc(doc: SourceDocument) {
    const i = documents.value.findIndex(
      (d) => d.source === doc.source && d.externalId === doc.externalId,
    )
    if (i >= 0) documents.value[i] = doc
    else documents.value.unshift(doc)
  }

  function upsertConnection(conn: DocumentConnection) {
    const i = connections.value.findIndex((c) => c.source === conn.source)
    if (i >= 0) connections.value[i] = conn
    else connections.value.push(conn)
  }

  /** Probe the integration: resolves `available`, the sources and connections. */
  async function probe() {
    if (!workspace.workspaceId) return
    try {
      const [{ sources: srcs }, { connections: conns }] = await Promise.all([
        api.listDocumentSources(workspace.requireId()),
        api.listDocumentConnections(workspace.requireId()),
      ])
      available.value = true
      sources.value = srcs
      connections.value = conns
    } catch {
      // 503 (integration disabled) or any error → hide the UI entry points.
      available.value = false
      sources.value = []
      connections.value = []
    }
  }

  /** Connect the workspace to a source with its credential bag. */
  async function connect(source: DocumentSourceKind, credentials: Record<string, string>) {
    const conn = await api.connectDocumentSource(workspace.requireId(), source, credentials)
    upsertConnection(conn)
    available.value = true
  }

  /** Disconnect the workspace from a source. */
  async function disconnect(source: DocumentSourceKind) {
    await api.disconnectDocumentSource(workspace.requireId(), source)
    connections.value = connections.value.filter((c) => c.source !== source)
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
    connect,
    disconnect,
    loadDocuments,
    importDocument,
    plan,
    spawn,
    linkToBlock,
  }
})
