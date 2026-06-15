import {
  NOTION_DESCRIPTOR,
  notionLogic,
  ValidationError,
  type DocumentContent,
  type DocumentCredentials,
  type DocumentSourceProvider,
  type NormalizedConnection,
} from '@cat-factory/core'

// NotionProvider: the document-source provider for Notion. It authenticates with
// a single internal-integration token (Bearer), fetches a page for its title and
// URL, then pages through the page's top-level blocks and converts them to the
// Markdown the planner consumes. Because the API host is fixed
// (`api.notion.com`) and there is no per-site base URL, there is no SSRF surface.
// Notion-specific *pure* logic (ref parsing, block → Markdown) lives in
// `@cat-factory/core`; this class is the thin `fetch` shell.

const API_BASE = 'https://api.notion.com/v1'
const NOTION_VERSION = '2022-06-28'
const USER_AGENT = 'cat-factory'
/** Bound the block backfill so a huge page can't stall an import (100 blocks/page). */
const MAX_BLOCK_PAGES = 5

/** Carries the HTTP status so callers can surface a meaningful error. */
export class NotionApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = 'NotionApiError'
  }
}

interface PageResponse {
  id?: string
  url?: string
  properties?: Record<string, unknown>
}

interface BlockChildrenResponse {
  results?: notionLogic.NotionBlock[]
  has_more?: boolean
  next_cursor?: string | null
}

export class NotionProvider implements DocumentSourceProvider {
  readonly kind = 'notion' as const
  readonly descriptor = NOTION_DESCRIPTOR

  normalizeConnection(input: DocumentCredentials): NormalizedConnection {
    const apiToken = input.apiToken?.trim()
    if (!apiToken) {
      throw new ValidationError('Notion requires an internal integration token')
    }
    return { credentials: { apiToken }, label: 'Notion workspace' }
  }

  parseRef(input: string): string | null {
    return notionLogic.parseNotionRef(input)
  }

  async fetchDocument(
    credentials: DocumentCredentials,
    externalId: string,
  ): Promise<DocumentContent> {
    const page = await this.get<PageResponse>(
      credentials,
      `/pages/${encodeURIComponent(externalId)}`,
    )
    if (!page.id) {
      throw new NotionApiError(502, `Notion returned an unexpected body for page ${externalId}`)
    }
    const blocks = await this.fetchBlocks(credentials, page.id)
    return {
      externalId: page.id,
      title: notionLogic.notionPageTitle(page.properties),
      url: page.url ?? `https://www.notion.so/${page.id.replace(/-/g, '')}`,
      body: notionLogic.notionBlocksToMarkdown(blocks),
    }
  }

  /** Page through a page's top-level blocks (bounded), returning them in order. */
  private async fetchBlocks(
    credentials: DocumentCredentials,
    pageId: string,
  ): Promise<notionLogic.NotionBlock[]> {
    const blocks: notionLogic.NotionBlock[] = []
    let cursor: string | undefined
    for (let i = 0; i < MAX_BLOCK_PAGES; i++) {
      const query = cursor
        ? `?page_size=100&start_cursor=${encodeURIComponent(cursor)}`
        : '?page_size=100'
      const res = await this.get<BlockChildrenResponse>(
        credentials,
        `/blocks/${encodeURIComponent(pageId)}/children${query}`,
      )
      if (Array.isArray(res.results)) blocks.push(...res.results)
      if (!res.has_more || !res.next_cursor) break
      cursor = res.next_cursor
    }
    return blocks
  }

  private async get<T>(credentials: DocumentCredentials, path: string): Promise<T> {
    const url = `${API_BASE}${path}`
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        authorization: `Bearer ${credentials.apiToken}`,
        'notion-version': NOTION_VERSION,
        accept: 'application/json',
        'user-agent': USER_AGENT,
      },
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new NotionApiError(
        res.status,
        `Notion GET ${url} → ${res.status}: ${text.slice(0, 300)}`,
      )
    }
    const json = (await res.json().catch(() => null)) as T | null
    if (json === null) {
      throw new NotionApiError(502, `Notion returned an unparseable body for ${path}`)
    }
    return json
  }
}
