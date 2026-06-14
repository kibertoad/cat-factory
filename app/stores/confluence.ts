import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type { ConfluenceBoardPlan, ConfluenceConnection, ConfluenceDocument } from '~/types/domain'
import { useWorkspaceStore } from '~/stores/workspace'

/**
 * Confluence integration state: the workspace's site connection and the pages it
 * has imported, plus the actions that connect/import/plan/spawn/link against the
 * backend. `available` mirrors the backend's opt-in gate — a 503 from the
 * connection probe means the integration is off, and the UI hides its entry
 * points (just as `auth.required` gates the login UI). Per-workspace, like the
 * board itself; nothing is persisted client-side.
 */
export const useConfluenceStore = defineStore('confluence', () => {
  const api = useApi()
  const workspace = useWorkspaceStore()

  /** null = unknown (not probed yet), true/false = integration on/off. */
  const available = ref<boolean | null>(null)
  const connection = ref<ConfluenceConnection | null>(null)
  const documents = ref<ConfluenceDocument[]>([])
  const loading = ref(false)

  const connected = computed(() => connection.value !== null)

  /** Imported documents currently attached to a given block. */
  function docsForBlock(blockId: string): ConfluenceDocument[] {
    return documents.value.filter((d) => d.linkedBlockId === blockId)
  }

  /** Merge a document returned by the backend into the local cache. */
  function upsertDoc(doc: ConfluenceDocument) {
    const i = documents.value.findIndex((d) => d.pageId === doc.pageId)
    if (i >= 0) documents.value[i] = doc
    else documents.value.unshift(doc)
  }

  /** Probe the integration: resolves `available` and the current connection. */
  async function probe() {
    if (!workspace.workspaceId) return
    try {
      const { connection: conn } = await api.getConfluenceConnection(workspace.requireId())
      available.value = true
      connection.value = conn
    } catch {
      // 503 (integration disabled) or any error → hide the UI entry points.
      available.value = false
      connection.value = null
    }
  }

  /** Connect the workspace to a Confluence site. */
  async function connect(input: { baseUrl: string; accountEmail: string; apiToken: string }) {
    connection.value = await api.connectConfluence(workspace.requireId(), input)
    available.value = true
  }

  /** Disconnect the workspace from Confluence. */
  async function disconnect() {
    await api.disconnectConfluence(workspace.requireId())
    connection.value = null
  }

  /** Load the imported documents for the workspace. */
  async function loadDocuments() {
    documents.value = await api.listConfluenceDocs(workspace.requireId())
  }

  /** Import (fetch + persist) a page by id or URL. */
  async function importDocument(page: string): Promise<ConfluenceDocument> {
    loading.value = true
    try {
      const doc = await api.importConfluenceDoc(workspace.requireId(), { page })
      upsertDoc(doc)
      return doc
    } finally {
      loading.value = false
    }
  }

  /** Preview the board structure a page would expand into (no writes). */
  function plan(pageId: string): Promise<ConfluenceBoardPlan> {
    return api.planConfluence(workspace.requireId(), pageId)
  }

  /** Apply a page's structure to the board, then refresh the board snapshot. */
  async function spawn(pageId: string, frameId?: string) {
    const { result } = await api.spawnConfluence(workspace.requireId(), { pageId, frameId })
    await workspace.refresh()
    return result
  }

  /** Attach an imported page to a block as agent context. */
  async function linkToBlock(blockId: string, pageId: string) {
    const doc = await api.linkConfluenceDoc(workspace.requireId(), pageId, { blockId })
    upsertDoc(doc)
    return doc
  }

  return {
    available,
    connection,
    documents,
    loading,
    connected,
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
