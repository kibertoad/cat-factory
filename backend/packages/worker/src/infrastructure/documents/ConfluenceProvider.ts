import {
  CONFLUENCE_DESCRIPTOR,
  confluenceLogic,
  ValidationError,
  type DocumentContent,
  type DocumentCredentials,
  type DocumentSourceProvider,
  type NormalizedConnection,
} from '@cat-factory/core'

// ConfluenceProvider: the document-source provider for Confluence Cloud. It
// authenticates with HTTP Basic (account email + API token), fetches a page in
// storage format, and converts the body to the Markdown the planner consumes.
// All Confluence-specific *pure* logic (ref parsing, base-URL SSRF guard,
// XHTML → Markdown) lives in `@cat-factory/core` so it is unit-testable; this
// class is the thin `fetch` shell around it. No SDK — fetch + `btoa` suffice.

const USER_AGENT = 'cat-factory'

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

interface ContentResponse {
  id?: string
  title?: string
  version?: { number?: number }
  body?: { storage?: { value?: string } }
  _links?: { base?: string; webui?: string }
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
    const baseUrl = confluenceLogic.normalizeBaseUrl(baseUrlRaw)
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
  ): Promise<DocumentContent> {
    const base = credentials.baseUrl!.replace(/\/+$/, '')
    const url = `${base}/wiki/rest/api/content/${encodeURIComponent(externalId)}?expand=body.storage,version`
    const auth = btoa(`${credentials.accountEmail}:${credentials.apiToken}`)

    const res = await fetch(url, {
      method: 'GET',
      headers: {
        authorization: `Basic ${auth}`,
        accept: 'application/json',
        'user-agent': USER_AGENT,
      },
    })

    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new ConfluenceApiError(
        res.status,
        `Confluence GET ${url} → ${res.status}: ${text.slice(0, 300)}`,
      )
    }

    const json = (await res.json().catch(() => null)) as ContentResponse | null
    if (!json || !json.id) {
      throw new ConfluenceApiError(
        502,
        `Confluence returned an unexpected body for page ${externalId}`,
      )
    }

    const linkBase = json._links?.base ?? `${base}/wiki`
    const webui = json._links?.webui ?? ''
    return {
      externalId: json.id,
      title: json.title ?? '(untitled)',
      url: `${linkBase}${webui}`,
      body: confluenceLogic.confluenceStorageToMarkdown(json.body?.storage?.value ?? ''),
    }
  }
}
