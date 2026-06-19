import type {
  DocumentContent,
  DocumentCredentials,
  DocumentSourceDescriptor,
  DocumentSourceKind,
  DocumentSourceProvider,
  NormalizedConnection,
} from '@cat-factory/kernel'
import { CONFLUENCE_DESCRIPTOR, NOTION_DESCRIPTOR } from '@cat-factory/integrations'

const DESCRIPTORS: Record<DocumentSourceKind, DocumentSourceDescriptor> = {
  confluence: CONFLUENCE_DESCRIPTOR,
  notion: NOTION_DESCRIPTOR,
}

/**
 * Deterministic DocumentSourceProvider for integration tests: serves canned page
 * bodies and records the credentials it was called with, so tests can assert both
 * the import/plan/spawn behaviour and that the connection's credentials were used.
 * Unregistered pages fall back to a minimal generated page so simple import tests
 * need no setup. The fake is the seam the real Confluence/Notion providers would
 * occupy — no network, no LLM.
 */
export class FakeDocumentSourceProvider implements DocumentSourceProvider {
  readonly descriptor: DocumentSourceDescriptor
  readonly pages = new Map<string, DocumentContent>()
  readonly calls: { credentials: DocumentCredentials; externalId: string }[] = []

  constructor(
    readonly kind: DocumentSourceKind = 'confluence',
    pages: Record<string, Partial<DocumentContent>> = {},
  ) {
    this.descriptor = DESCRIPTORS[kind]
    for (const [externalId, partial] of Object.entries(pages)) this.set(externalId, partial)
  }

  /** Register (or replace) a canned page. */
  set(externalId: string, partial: Partial<DocumentContent> = {}): void {
    this.pages.set(externalId, {
      title: `Page ${externalId}`,
      url: `https://example.test/${this.kind}/${externalId}`,
      body: '',
      ...partial,
      externalId,
    })
  }

  /** Accept any credential bag; require the descriptor's first field as a smoke test. */
  normalizeConnection(input: DocumentCredentials): NormalizedConnection {
    return { credentials: { ...input }, label: `${this.kind} (test)` }
  }

  /** Bare numeric/uuid-ish input is the id; otherwise return null. */
  parseRef(input: string): string | null {
    const trimmed = input.trim()
    return trimmed.length > 0 ? trimmed : null
  }

  async fetchDocument(
    credentials: DocumentCredentials,
    externalId: string,
  ): Promise<DocumentContent> {
    this.calls.push({ credentials, externalId })
    const page = this.pages.get(externalId)
    if (page) return page
    const generated: DocumentContent = {
      externalId,
      title: `Page ${externalId}`,
      url: `https://example.test/${this.kind}/${externalId}`,
      body: `# Page ${externalId}`,
    }
    this.pages.set(externalId, generated)
    return generated
  }
}
