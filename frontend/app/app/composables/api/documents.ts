import type {
  DocumentBoardPlan,
  DocumentConnection,
  DocumentSearchResult,
  DocumentSourceDescriptor,
  DocumentSourceKind,
  SourceDocument,
  SpawnResult,
} from '~/types/domain'
import type { ApiContext } from './context'

/** Document sources (Confluence, Notion, …): connect, import, search, board-spawn. */
export function documentsApi({ http, ws }: ApiContext) {
  return {
    // ---- document sources (Confluence, Notion, …) -------------------------
    // The configured sources + their connect/import metadata. A 503 means the
    // integration is off (the store hides its UI on any error here).
    listDocumentSources: (workspaceId: string) =>
      http<{ sources: DocumentSourceDescriptor[] }>(`${ws(workspaceId)}/document-sources`),

    listDocumentConnections: (workspaceId: string) =>
      http<{ connections: DocumentConnection[] }>(
        `${ws(workspaceId)}/document-sources/connections`,
      ),

    connectDocumentSource: (
      workspaceId: string,
      source: DocumentSourceKind,
      credentials: Record<string, string>,
    ) =>
      http<DocumentConnection>(`${ws(workspaceId)}/document-sources/${source}/connect`, {
        method: 'POST',
        body: { credentials },
      }),

    disconnectDocumentSource: (workspaceId: string, source: DocumentSourceKind) =>
      http(`${ws(workspaceId)}/document-sources/${source}/connection`, { method: 'DELETE' }),

    listDocuments: (workspaceId: string) => http<SourceDocument[]>(`${ws(workspaceId)}/documents`),

    importDocument: (workspaceId: string, source: DocumentSourceKind, body: { ref: string }) =>
      http<SourceDocument>(`${ws(workspaceId)}/document-sources/${source}/import`, {
        method: 'POST',
        body,
      }),

    searchDocumentSource: (workspaceId: string, source: DocumentSourceKind, query: string) =>
      http<{ results: DocumentSearchResult[] }>(
        `${ws(workspaceId)}/document-sources/${source}/search`,
        { method: 'POST', body: { query } },
      ),

    planDocument: (workspaceId: string, source: DocumentSourceKind, externalId: string) =>
      http<DocumentBoardPlan>(`${ws(workspaceId)}/document-sources/${source}/plan`, {
        method: 'POST',
        body: { externalId },
      }),

    spawnDocument: (
      workspaceId: string,
      source: DocumentSourceKind,
      body: { externalId: string; frameId?: string },
    ) =>
      http<{ plan: DocumentBoardPlan; result: SpawnResult }>(
        `${ws(workspaceId)}/document-sources/${source}/spawn`,
        { method: 'POST', body },
      ),

    linkDocument: (
      workspaceId: string,
      body: { source: DocumentSourceKind; externalId: string; blockId: string },
    ) => http<SourceDocument>(`${ws(workspaceId)}/documents/link`, { method: 'POST', body }),
  }
}
