import {
  ValidationError,
  type DocumentContent,
  type DocumentCredentials,
  type DocumentSourceProvider,
  type NormalizedConnection,
} from '@cat-factory/kernel'
import { CONFLUENCE_DESCRIPTOR, confluenceLogic } from '@cat-factory/integrations'

// ConfluenceProvider: the document-source provider for Confluence Cloud. It
// authenticates with HTTP Basic (account email + API token), fetches a page in
// storage format, and converts the body to the Markdown the planner consumes.
// All Confluence-specific *pure* logic (ref parsing, base-URL SSRF guard,
// XHTML → Markdown) lives in `@cat-factory/core` so it is unit-testable; this
// class is the thin `fetch` shell around it. No SDK — fetch + `btoa` suffice.

const USER_AGENT = 'cat-factory'
/** Bound the redirect chain so a permitted first hop can't walk us anywhere. */
const MAX_REDIRECTS = 5
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

/**
 * `fetch` with redirects followed by hand so the SSRF guard runs against EVERY
 * hop. With the default `redirect: 'follow'` the permitted site could 302 to an
 * internal target (or downgrade https→http) and the runtime would follow it
 * unchecked, leaking the Basic-auth token. We force `redirect: 'manual'`,
 * re-resolve the `Location` against the current URL, and re-run the same
 * `assertSafe` guard (https-only + host blocklist) before following.
 */
async function safeFetch(
  url: string,
  init: RequestInit,
  assertSafe: (u: string) => void,
): Promise<Response> {
  let current = url
  for (let hop = 0; ; hop++) {
    assertSafe(current)
    const res = await fetch(current, { ...init, redirect: 'manual' })
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location')
      if (!location) return res
      if (hop >= MAX_REDIRECTS) {
        throw new ConfluenceApiError(502, 'Confluence returned too many redirects')
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
    throw new ConfluenceApiError(502, 'Confluence response too large')
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
        throw new ConfluenceApiError(502, 'Confluence response too large')
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
    )

    if (!res.ok) {
      const text = await readCappedText(res, MAX_RESPONSE_BYTES).catch(() => '')
      throw new ConfluenceApiError(
        res.status,
        `Confluence GET ${url} → ${res.status}: ${text.slice(0, 300)}`,
      )
    }

    const text = await readCappedText(res, MAX_RESPONSE_BYTES)
    const json = (() => {
      try {
        return JSON.parse(text) as ContentResponse
      } catch {
        return null
      }
    })()
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
