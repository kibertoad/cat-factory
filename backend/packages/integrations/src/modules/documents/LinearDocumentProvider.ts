import {
  ValidationError,
  type DocumentContent,
  type DocumentCredentials,
  type DocumentSearchResult,
  type DocumentSourceProvider,
  type NormalizedConnection,
} from '@cat-factory/kernel'
import { LinearGraphqlClient } from '../shared/linear.client.js'
import {
  LINEAR_DOCS_DESCRIPTOR,
  LINEAR_DOCUMENT_QUERY,
  LINEAR_DOCUMENTS_SEARCH_QUERY,
  mapLinearDocument,
  mapLinearDocumentSearch,
  parseLinearDocRef,
} from './linear-docs.logic.js'

// LinearDocumentProvider: the document-source provider for Linear **Docs**. It
// authenticates with a personal API key against Linear's single GraphQL endpoint
// (via the shared host-pinned, redirect-safe client) and maps a document onto the
// generic Markdown {@link DocumentContent} the planner consumes. All Linear-specific
// pure logic (ref parsing, response mapping, the GraphQL documents) lives in
// `linear-docs.logic` so it is unit-testable; this class is the thin transport.
//
// Runtime-neutral: it depends only on the kernel ports + the shared client (global
// `fetch`, present on both runtimes), so the Cloudflare and Node facades compose
// the SAME class (see CLAUDE.md "Keep the runtimes symmetric").

export class LinearDocumentProvider implements DocumentSourceProvider {
  readonly kind = 'linear' as const
  readonly descriptor = LINEAR_DOCS_DESCRIPTOR

  normalizeConnection(input: DocumentCredentials): NormalizedConnection {
    const apiKey = input.apiKey?.trim()
    if (!apiKey) {
      throw new ValidationError('Linear requires a personal API key')
    }
    return { credentials: { apiKey }, label: 'Linear workspace' }
  }

  parseRef(input: string): string | null {
    return parseLinearDocRef(input)
  }

  async fetchDocument(
    credentials: DocumentCredentials,
    externalId: string,
  ): Promise<DocumentContent> {
    const client = new LinearGraphqlClient({ apiKey: credentials.apiKey! })
    const data = await client.query<{
      document?: Parameters<typeof mapLinearDocument>[0]['document']
    }>(LINEAR_DOCUMENT_QUERY, { id: externalId })
    return mapLinearDocument(data)
  }

  async search(credentials: DocumentCredentials, query: string): Promise<DocumentSearchResult[]> {
    const client = new LinearGraphqlClient({ apiKey: credentials.apiKey! })
    const data = await client.query<Parameters<typeof mapLinearDocumentSearch>[0]>(
      LINEAR_DOCUMENTS_SEARCH_QUERY,
      { term: query },
    )
    return mapLinearDocumentSearch(data)
  }
}
