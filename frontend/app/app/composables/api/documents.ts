import {
  connectDocumentSourceContract,
  disconnectDocumentSourceContract,
  importDocumentContract,
  linkDocumentContract,
  linkDocumentForKindContract,
  listDocumentConnectionsContract,
  listDocumentRoleLinksContract,
  listDocumentsContract,
  listDocumentSourcesContract,
  planDocumentContract,
  resolveDocumentRefContract,
  searchDocumentsContract,
  spawnDocumentContract,
  unlinkDocumentForKindContract,
} from '@cat-factory/contracts'
import type { DocKind, DocumentLinkRole, DocumentOrigin, DocumentSourceKind } from '~/types/domain'
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

    // Canonicalise a pasted URL/id without importing it: the pre-flight the attach pickers run
    // so an unusable link is corrected before the task that carries it is saved.
    resolveDocumentRef: (workspaceId: string, source: DocumentSourceKind, body: { ref: string }) =>
      send(resolveDocumentRefContract, {
        pathPrefix: ws(workspaceId),
        pathParams: { source },
        body,
      }),

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
      body: { source: DocumentOrigin; externalId: string; blockId: string },
    ) => send(linkDocumentContract, { pathPrefix: ws(workspaceId), body }),

    // ---- workspace+DocKind template / exemplar links (WS1) ----------------
    listDocumentRoleLinks: (workspaceId: string) =>
      send(listDocumentRoleLinksContract, { pathPrefix: ws(workspaceId) }),

    linkDocumentForKind: (
      workspaceId: string,
      body: {
        source: DocumentOrigin
        externalId: string
        role: DocumentLinkRole
        docKind: DocKind
      },
    ) => send(linkDocumentForKindContract, { pathPrefix: ws(workspaceId), body }),

    unlinkDocumentForKind: (
      workspaceId: string,
      body: { source: DocumentOrigin; externalId: string },
    ) => send(unlinkDocumentForKindContract, { pathPrefix: ws(workspaceId), body }),
  }
}
