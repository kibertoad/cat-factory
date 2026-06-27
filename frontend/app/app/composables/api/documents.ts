import {
  connectDocumentSourceContract,
  disconnectDocumentSourceContract,
  importDocumentContract,
  linkDocumentContract,
  listDocumentConnectionsContract,
  listDocumentsContract,
  listDocumentSourcesContract,
  planDocumentContract,
  searchDocumentsContract,
  spawnDocumentContract,
} from '@cat-factory/contracts'
import type { DocumentSourceKind } from '~/types/domain'
import type { ApiContext } from './context'

/** Document sources (Confluence, Notion, …): connect, import, search, board-spawn. */
export function documentsApi({ send, ws }: ApiContext) {
  return {
    // ---- document sources (Confluence, Notion, …) -------------------------
    // The configured sources + their connect/import metadata. A 503 means the
    // integration is off (the store hides its UI on any error here).
    listDocumentSources: (workspaceId: string) =>
      send(listDocumentSourcesContract, { pathPrefix: ws(workspaceId) }),

    listDocumentConnections: (workspaceId: string) =>
      send(listDocumentConnectionsContract, { pathPrefix: ws(workspaceId) }),

    connectDocumentSource: (
      workspaceId: string,
      source: DocumentSourceKind,
      credentials: Record<string, string>,
    ) =>
      send(connectDocumentSourceContract, {
        pathPrefix: ws(workspaceId),
        pathParams: { source },
        body: { credentials },
      }),

    disconnectDocumentSource: (workspaceId: string, source: DocumentSourceKind) =>
      send(disconnectDocumentSourceContract, {
        pathPrefix: ws(workspaceId),
        pathParams: { source },
      }),

    listDocuments: (workspaceId: string) =>
      send(listDocumentsContract, { pathPrefix: ws(workspaceId) }),

    importDocument: (workspaceId: string, source: DocumentSourceKind, body: { ref: string }) =>
      send(importDocumentContract, { pathPrefix: ws(workspaceId), pathParams: { source }, body }),

    searchDocumentSource: (workspaceId: string, source: DocumentSourceKind, query: string) =>
      send(searchDocumentsContract, {
        pathPrefix: ws(workspaceId),
        pathParams: { source },
        body: { query },
      }),

    planDocument: (workspaceId: string, source: DocumentSourceKind, externalId: string) =>
      send(planDocumentContract, {
        pathPrefix: ws(workspaceId),
        pathParams: { source },
        body: { externalId },
      }),

    spawnDocument: (
      workspaceId: string,
      source: DocumentSourceKind,
      body: { externalId: string; frameId?: string },
    ) => send(spawnDocumentContract, { pathPrefix: ws(workspaceId), pathParams: { source }, body }),

    linkDocument: (
      workspaceId: string,
      body: { source: DocumentSourceKind; externalId: string; blockId: string },
    ) => send(linkDocumentContract, { pathPrefix: ws(workspaceId), body }),
  }
}
