import {
  ValidationError,
  type DocumentContent,
  type DocumentCredentials,
  type DocumentSearchResult,
  type DocumentSourceProvider,
  type NormalizedConnection,
} from '@cat-factory/kernel'
import { NOTION_DESCRIPTOR } from './notion.logic.js'
import * as notionLogic from './notion.logic.js'

// NotionProvider: the document-source provider for Notion. It authenticates with
// a single internal-integration token (Bearer), fetches a page for its title and
// URL, then pages through the page's top-level blocks and converts them to the
// Markdown the planner consumes. Because the API host is fixed
// (`api.notion.com`) and there is no per-site base URL, there is no SSRF surface.
// Notion-specific *pure* logic (ref parsing, block → Markdown) lives in
// `@cat-factory/integrations`; this class is the thin `fetch` shell.

const API_BASE = 'https://api.notion.com/v1'
const NOTION_API_HOST = 'api.notion.com'
const NOTION_VERSION = '2022-06-28'
const USER_AGENT = 'cat-factory'
/** Bound the block backfill so a huge page can't stall an import (100 blocks/page). */
const MAX_BLOCK_PAGES = 5
/** Bound the redirect chain so the fixed API host can't 302 us elsewhere. */
const MAX_REDIRECTS = 5
/** Hard cap on the bytes read off any response body, to protect the isolate. */
const MAX_RESPONSE_BYTES = 5_000_000

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

/**
 * The Notion API host is fixed, so any redirect must stay on `api.notion.com`
 * over https. A redirect off-host (e.g. to an internal address) is treated as an
 * SSRF attempt and rejected. Mirrors the per-hop guard the site-configurable
 * providers run.
 */
function assertSafeNotionUrl(url: string): void {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new NotionApiError(502, `Notion request URL is invalid: ${url}`)
  }
  if (parsed.protocol !== 'https:') {
    throw new NotionApiError(502, 'Notion request must use https')
  }
  if (parsed.hostname.toLowerCase() !== NOTION_API_HOST) {
    throw new NotionApiError(502, `Notion redirect to a disallowed host: ${parsed.hostname}`)
  }
}

/**
 * `fetch` with redirects followed by hand so the host guard runs against EVERY
 * hop. With the default `redirect: 'follow'` a 302 from the API could be chased
 * to an internal target (or downgraded to http), leaking the Bearer token. We
 * force `redirect: 'manual'`, re-resolve the `Location`, and re-validate.
 */
async function safeFetch(url: string, init: RequestInit): Promise<Response> {
  let current = url
  for (let hop = 0; ; hop++) {
    assertSafeNotionUrl(current)
    const res = await fetch(current, { ...init, redirect: 'manual' })
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location')
      if (!location) return res
      if (hop >= MAX_REDIRECTS) {
        throw new NotionApiError(502, 'Notion returned too many redirects')
      }
      current = new URL(location, current).toString()
      continue
    }
    return res
  }
}

/**
 * Read a response body with a running byte cap so a hostile/huge response can't
 * OOM the isolate. Checks the declared Content-Length first, then enforces the
 * cap while streaming.
 */
async function readCappedText(res: Response, maxBytes: number): Promise<string> {
  const declared = res.headers.get('content-length')
  if (declared && Number(declared) > maxBytes) {
    throw new NotionApiError(502, 'Notion response too large')
  }
  const body = res.body
  if (!body) return ''
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      total += value.byteLength
      if (total > maxBytes) {
        await reader.cancel()
        throw new NotionApiError(502, 'Notion response too large')
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  const merged = new Uint8Array(total)
  let offset = 0
  for (const c of chunks) {
    merged.set(c, offset)
    offset += c.byteLength
  }
  return new TextDecoder().decode(merged)
}

interface PageResponse {
  id?: string
  url?: string
  properties?: Record<string, unknown>
  /** ISO timestamp Notion advances on every edit — the version token. */
  last_edited_time?: string
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
      version: page.last_edited_time ?? '',
    }
  }

  /**
   * The cheap version probe: read only the page object for its `last_edited_time`,
   * skipping the (bounded but multi-request) block backfill that dominates a full
   * fetch. An unchanged timestamp means the page body is still current.
   */
  async probeVersion(credentials: DocumentCredentials, externalId: string): Promise<string> {
    const page = await this.get<PageResponse>(
      credentials,
      `/pages/${encodeURIComponent(externalId)}`,
    )
    if (!page.id) {
      throw new NotionApiError(502, `Notion returned an unexpected body for page ${externalId}`)
    }
    return page.last_edited_time ?? ''
  }

  async search(credentials: DocumentCredentials, query: string): Promise<DocumentSearchResult[]> {
    const res = await safeFetch(`${API_BASE}/search`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${credentials.apiToken}`,
        'notion-version': NOTION_VERSION,
        accept: 'application/json',
        'content-type': 'application/json',
        'user-agent': USER_AGENT,
      },
      body: JSON.stringify({
        query,
        filter: { property: 'object', value: 'page' },
        page_size: 20,
      }),
    })
    if (!res.ok) {
      const text = await readCappedText(res, MAX_RESPONSE_BYTES).catch(() => '')
      throw new NotionApiError(res.status, `Notion search → ${res.status}: ${text.slice(0, 300)}`)
    }
    const text = await readCappedText(res, MAX_RESPONSE_BYTES)
    const json = (() => {
      try {
        return JSON.parse(text)
      } catch {
        return null
      }
    })()
    return notionLogic.parseNotionSearchResults(json)
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
    const res = await safeFetch(url, {
      method: 'GET',
      headers: {
        authorization: `Bearer ${credentials.apiToken}`,
        'notion-version': NOTION_VERSION,
        accept: 'application/json',
        'user-agent': USER_AGENT,
      },
    })
    if (!res.ok) {
      const text = await readCappedText(res, MAX_RESPONSE_BYTES).catch(() => '')
      throw new NotionApiError(
        res.status,
        `Notion GET ${url} → ${res.status}: ${text.slice(0, 300)}`,
      )
    }
    const text = await readCappedText(res, MAX_RESPONSE_BYTES)
    const json = (() => {
      try {
        return JSON.parse(text) as T
      } catch {
        return null
      }
    })()
    if (json === null) {
      throw new NotionApiError(502, `Notion returned an unparseable body for ${path}`)
    }
    return json
  }
}
