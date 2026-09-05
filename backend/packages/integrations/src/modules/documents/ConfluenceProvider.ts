import {
  ValidationError,
  type DocumentContent,
  type DocumentCredentials,
  type DocumentSearchResult,
  type DocumentSourceProvider,
  type NormalizedConnection,
} from '@cat-factory/kernel'
import { readCappedText, safeFetch } from '../shared/safe-fetch.js'
import { CONFLUENCE_DESCRIPTOR } from './confluence.logic.js'
import * as confluenceLogic from './confluence.logic.js'
import { normalizeAtlassianBaseUrl } from '@cat-factory/kernel'

// ConfluenceProvider: the document-source provider for Confluence Cloud. It
// authenticates with HTTP Basic (account email + API token), fetches a page in
// storage format, and converts the body to the Markdown the planner consumes.
//
// Page reads go through Confluence Cloud REST **v2** (`/wiki/api/v2/pages/{id}`).
// The v1 `/wiki/rest/api/content/{id}` this used to call was retired on 2025-04-30
// under Atlassian's RFC-19 and is gone from the v1 reference; search is the one
// call that stays on v1, because v2 publishes no search endpoint at all.
// All Confluence-specific *pure* logic (ref parsing, base-URL SSRF guard,
// XHTML → Markdown) lives in `@cat-factory/integrations` so it is unit-testable; this
// class is the thin `fetch` shell around it. No SDK — fetch + `btoa` suffice.

const USER_AGENT = 'cat-factory'
/** Hard cap on the bytes read off any response body, to protect the isolate. */
const MAX_RESPONSE_BYTES = 5_000_000

/** Carries the HTTP status so callers can surface a meaningful error. */
export class ConfluenceApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = 'ConfluenceApiError'
  }
}

/** Build a {@link ConfluenceApiError} for the shared `safeFetch`/`readCappedText` helpers. */
const makeConfluenceError = (status: number, message: string): ConfluenceApiError =>
  new ConfluenceApiError(status, `Confluence: ${message}`)

/** A v2 page. `id` is a string in v2 responses; older sites have been seen to send a number. */
interface PageResponse {
  id?: string | number
  title?: string
  version?: { number?: number }
  body?: { storage?: { value?: string } }
  _links?: { base?: string; webui?: string }
}

/** The page's monotonic version number as the opaque staleness token (`''` if absent). */
function versionToken(json: PageResponse): string {
  return json.version?.number !== undefined ? String(json.version.number) : ''
}

export class ConfluenceProvider implements DocumentSourceProvider {
  readonly kind = 'confluence' as const
  readonly descriptor = CONFLUENCE_DESCRIPTOR

  normalizeConnection(input: DocumentCredentials): NormalizedConnection {
    const baseUrlRaw = input.baseUrl?.trim()
    const accountEmail = input.accountEmail?.trim()
    const apiToken = input.apiToken?.trim()
    if (!baseUrlRaw || !accountEmail || !apiToken) {
      throw new ValidationError('Confluence requires a site URL, account email and API token')
    }
    const baseUrl = normalizeAtlassianBaseUrl(baseUrlRaw)
    // Guard against SSRF: the stored base URL is later fetched with the
    // workspace's credentials, so it must be a public https host.
    confluenceLogic.assertSafeConfluenceBaseUrl(baseUrl)
    return {
      credentials: { baseUrl, accountEmail, apiToken },
      label: baseUrl,
    }
  }

  parseRef(input: string): string | null {
    return confluenceLogic.parseConfluenceRef(input)
  }

  async fetchDocument(
    credentials: DocumentCredentials,
    externalId: string,
    _workspaceId: string | null,
  ): Promise<DocumentContent> {
    const base = credentials.baseUrl!.replace(/\/+$/, '')
    // v2 always carries `version`; `body-format` is what decides whether the XHTML rides along.
    const json = await this.getPage(credentials, externalId, 'storage')

    const linkBase = json._links?.base ?? `${base}/wiki`
    const webui = json._links?.webui ?? ''
    return {
      externalId: String(json.id),
      title: json.title ?? '(untitled)',
      url: `${linkBase}${webui}`,
      body: confluenceLogic.confluenceStorageToMarkdown(json.body?.storage?.value ?? ''),
      version: versionToken(json),
    }
  }

  /**
   * The cheap version probe: omit `body-format`, so the page's XHTML is neither
   * transferred nor converted and the staleness check costs a metadata read rather
   * than a full fetch. v2 returns `version` on the page either way.
   */
  async probeVersion(
    credentials: DocumentCredentials,
    externalId: string,
    _workspaceId: string | null,
  ): Promise<string> {
    return versionToken(await this.getPage(credentials, externalId, null))
  }

  /** Shared page read; `bodyFormat` selects how much of the page is materialised. */
  private async getPage(
    credentials: DocumentCredentials,
    externalId: string,
    bodyFormat: 'storage' | null,
  ): Promise<PageResponse> {
    const base = credentials.baseUrl!.replace(/\/+$/, '')
    const query = bodyFormat ? `?body-format=${bodyFormat}` : ''
    const url = `${base}/wiki/api/v2/pages/${encodeURIComponent(externalId)}${query}`
    const auth = btoa(`${credentials.accountEmail}:${credentials.apiToken}`)

    const res = await safeFetch(
      url,
      {
        method: 'GET',
        headers: {
          authorization: `Basic ${auth}`,
          accept: 'application/json',
          'user-agent': USER_AGENT,
        },
      },
      (u) => confluenceLogic.assertSafeConfluenceBaseUrl(u),
      makeConfluenceError,
    )

    if (!res.ok) {
      const text = await readCappedText(res, MAX_RESPONSE_BYTES, makeConfluenceError, false).catch(
        () => '',
      )
      throw new ConfluenceApiError(
        res.status,
        `Confluence GET ${url} → ${res.status}: ${text.slice(0, 300)}`,
      )
    }

    const text = await readCappedText(res, MAX_RESPONSE_BYTES, makeConfluenceError)
    const json = (() => {
      try {
        return JSON.parse(text) as PageResponse
      } catch {
        return null
      }
    })()
    if (!json || json.id === undefined || json.id === null || json.id === '') {
      throw new ConfluenceApiError(
        502,
        `Confluence returned an unexpected body for page ${externalId}`,
      )
    }
    return json
  }

  /**
   * CQL search stays on v1 deliberately: RFC-19 did not retire
   * `GET /wiki/rest/api/content/search`, and v2 publishes no search endpoint to move to.
   */
  async search(credentials: DocumentCredentials, query: string): Promise<DocumentSearchResult[]> {
    const base = credentials.baseUrl!.replace(/\/+$/, '')
    const cql = encodeURIComponent(confluenceLogic.buildConfluenceSearchCql(query))
    const url = `${base}/wiki/rest/api/content/search?cql=${cql}&limit=20`
    const auth = btoa(`${credentials.accountEmail}:${credentials.apiToken}`)

    const res = await safeFetch(
      url,
      {
        method: 'GET',
        headers: {
          authorization: `Basic ${auth}`,
          accept: 'application/json',
          'user-agent': USER_AGENT,
        },
      },
      (u) => confluenceLogic.assertSafeConfluenceBaseUrl(u),
      makeConfluenceError,
    )
    if (!res.ok) {
      const text = await readCappedText(res, MAX_RESPONSE_BYTES, makeConfluenceError, false).catch(
        () => '',
      )
      throw new ConfluenceApiError(
        res.status,
        `Confluence search ${url} → ${res.status}: ${text.slice(0, 300)}`,
      )
    }
    const text = await readCappedText(res, MAX_RESPONSE_BYTES, makeConfluenceError)
    const json = (() => {
      try {
        return JSON.parse(text)
      } catch {
        return null
      }
    })()
    return confluenceLogic.parseConfluenceSearchResults(json, base)
  }
}
