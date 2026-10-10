import type {
  DocumentContent,
  DocumentSearchResult,
  DocumentSourceDescriptor,
} from '@cat-factory/kernel'

// Linear-document pure logic, kept out of the provider so it is unit-testable
// without a live API: the connect-form descriptor, parsing a document id out of
// user input, and mapping the GraphQL responses onto the generic shapes. Linear
// document `content` is already Markdown, so the only normalization is collapsing
// runaway blank lines — no block→Markdown conversion (unlike Notion/Confluence).
//
// Scope: the document source covers Linear **Docs** only (project + standalone
// documents). Issue descriptions are surfaced through the Linear **task** source
// instead, so the same content is never double-imported.

/** What the connect UI renders, and which credentials the provider needs. */
export const LINEAR_DOCS_DESCRIPTOR: DocumentSourceDescriptor = {
  source: 'linear',
  label: 'Linear',
  // Same Linear glyph the task source + tracker UI use, so the brand is consistent
  // wherever Linear surfaces (the document picker, the task picker, the tracker).
  icon: 'i-lucide-square-kanban',
  credentialFields: [
    {
      key: 'apiKey',
      label: 'Personal API key',
      secret: true,
      placeholder: 'lin_api_…',
      help: 'Create one at linear.app → Settings → Security & access → Personal API keys',
    },
  ],
  refLabel: 'Document URL or ID',
  refPlaceholder: 'https://linear.app/acme/document/…  or  a document id',
  searchable: true,
}

// ---- GraphQL operations (the provider is a thin transport around these) -----

/** Fetch a single document's title, URL and Markdown content. */
export const LINEAR_DOCUMENT_QUERY = `query Document($id: String!) {
  document(id: $id) { id title url content updatedAt }
}`

/** Cheap staleness probe: the document's `updatedAt` only (no `content` body). */
export const LINEAR_DOCUMENT_VERSION_QUERY = `query DocumentVersion($id: String!) {
  document(id: $id) { id updatedAt }
}`

/** Search documents by title (used to populate the import picker). */
export const LINEAR_DOCUMENTS_SEARCH_QUERY = `query Documents($term: String!) {
  documents(first: 20, filter: { title: { containsIgnoreCase: $term } }) {
    nodes { id title url }
  }
}`

interface LinearDocumentNode {
  id?: string
  title?: string
  url?: string
  content?: string | null
  /** ISO timestamp Linear advances on every edit — the version token. */
  updatedAt?: string | null
}

/**
 * Resolve a Linear document id from raw user input: a bare id, or a
 * `…/document/<slugId>` URL whose final path segment is the document's slug id
 * (Linear embeds the document's slugId as the trailing segment — the value its
 * `document(id:)` query accepts alongside the raw UUID). Returns the id, or null
 * when nothing parses. Kept lenient (like Notion's ref parsing) — the
 * `document(id:)` query is the final arbiter of whether the id resolves, so a
 * bare UUID and a copied document URL both work.
 */
export function parseLinearDocRef(input: string): string | null {
  const trimmed = input.trim()
  if (!trimmed) return null
  const url = (() => {
    try {
      return new URL(trimmed)
    } catch {
      return null
    }
  })()
  if (!url) {
    // A bare id: anything without whitespace or a path separator.
    return /^[^\s/]+$/.test(trimmed) ? trimmed : null
  }
  if (url.hostname.toLowerCase() !== 'linear.app') return null
  const segments = url.pathname.split('/').filter(Boolean)
  const docIdx = segments.indexOf('document')
  if (docIdx === -1 || docIdx + 1 >= segments.length) return null
  return segments[docIdx + 1] || null
}

/** Collapse runaway blank lines in already-Markdown content. */
function normalizeMarkdown(content: string): string {
  return content
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** Map a `document` GraphQL payload onto the generic {@link DocumentContent}. */
export function mapLinearDocument(data: { document?: LinearDocumentNode | null }): DocumentContent {
  const doc = data.document
  if (!doc?.id) throw new Error('Linear returned no document for the requested id')
  return {
    externalId: doc.id,
    title: doc.title?.trim() || '(untitled)',
    url: doc.url ?? `https://linear.app/document/${doc.id}`,
    body: normalizeMarkdown(doc.content ?? ''),
    version: doc.updatedAt ?? '',
  }
}

/** The version token from a `document { id updatedAt }` probe payload. */
export function linearDocumentVersion(data: {
  document?: { updatedAt?: string | null } | null
}): string {
  return data.document?.updatedAt ?? ''
}

/** Map a `documents` search payload onto lean {@link DocumentSearchResult} hits. */
export function mapLinearDocumentSearch(data: {
  documents?: { nodes?: LinearDocumentNode[] }
}): DocumentSearchResult[] {
  const nodes = data.documents?.nodes ?? []
  const out: DocumentSearchResult[] = []
  for (const node of nodes) {
    if (!node.id) continue
    out.push({
      source: 'linear',
      externalId: node.id,
      title: node.title?.trim() || '(untitled)',
      url: node.url ?? `https://linear.app/document/${node.id}`,
      excerpt: '',
    })
  }
  return out
}
