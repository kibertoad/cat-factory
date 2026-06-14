import type {
  ConfluenceClient,
  ConfluenceCredentials,
  ConfluencePageContent,
} from '@cat-factory/core'

// Thin `fetch`-based ConfluenceClient: the only place that talks to the
// Confluence Cloud REST API. It authenticates with HTTP Basic (account email +
// API token), as recommended for Confluence Cloud, and maps the content response
// to the port's projection shape. As with the GitHub client, no SDK is used —
// fetch + the platform's `btoa` cover everything we need.

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
  space?: { key?: string }
  version?: { number?: number }
  body?: { storage?: { value?: string } }
  _links?: { base?: string; webui?: string }
}

export class FetchConfluenceClient implements ConfluenceClient {
  async getPage(creds: ConfluenceCredentials, pageId: string): Promise<ConfluencePageContent> {
    const base = creds.baseUrl.replace(/\/+$/, '')
    const url = `${base}/wiki/rest/api/content/${encodeURIComponent(pageId)}?expand=body.storage,version,space`
    const auth = btoa(`${creds.email}:${creds.apiToken}`)

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
      throw new ConfluenceApiError(502, `Confluence returned an unexpected body for page ${pageId}`)
    }

    const linkBase = json._links?.base ?? `${base}/wiki`
    const webui = json._links?.webui ?? ''
    return {
      pageId: json.id,
      spaceKey: json.space?.key ?? '',
      title: json.title ?? '(untitled)',
      url: `${linkBase}${webui}`,
      version: json.version?.number ?? 0,
      body: json.body?.storage?.value ?? '',
    }
  }
}
