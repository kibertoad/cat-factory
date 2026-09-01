import type {
  ConnectionTestResult,
  ServiceCatalogAuth,
  ServiceCatalogCoverage,
  ServiceCatalogProvider,
} from '@cat-factory/contracts'
import type {
  Logger,
  ServiceCatalogApi,
  ServiceCatalogClient,
  ServiceCatalogEntry,
  ServiceCatalogFetch,
  ServiceCatalogFetchOptions,
  UrlSafetyPolicy,
} from '@cat-factory/kernel'
import {
  UnavailableError,
  connectionFailureResult,
  noopLogger,
  redactSecrets,
} from '@cat-factory/kernel'
import { assertSafePublicUrl } from '../shared/url-guard.js'
import { readCappedText, safeFetch } from '../shared/safe-fetch.js'
import {
  API_FETCH_FIELDS,
  CATALOG_LIST_FIELDS,
  type BackstageEntity,
  providedApiRefs,
  serviceIdForEntity,
  toServiceCatalogApi,
  toServiceCatalogEntry,
} from './backstage-catalog.logic.js'
import {
  clientCredentialsBody,
  mintLegacyBackstageToken,
  readAccessToken,
  requiresResolvedBearer,
  serviceCatalogAuthHeaders,
} from './serviceCatalogAuth.js'

// ---------------------------------------------------------------------------
// The WIRE half of the Backstage adapter: paged reads of the Software Catalog, and the token
// exchange the proxied deployments need. Hand-rolled on `fetch` (no vendor SDK) so it bundles
// into a Worker isolate, exactly as the MCP OAuth client is.
//
// Two requests per import, never one per service. The listing runs against
// `/entities/by-query` with a `fields` projection that leaves out the API definitions, and the
// definitions come back from ONE batched `/entities/by-refs` per chunk of references. A
// per-service definition fetch would be a textbook N+1 against someone else's server.
// ---------------------------------------------------------------------------

/** How many entities one listing page asks for. The vendor's own default ceiling is higher. */
const PAGE_SIZE = 100

/** How many pages one import will walk, whatever the cap says. A stop, not a policy. */
const MAX_PAGES = 50

/** How many entity references ride one batched by-refs request. */
const REF_CHUNK = 50

/**
 * How many API entities one import will resolve in total.
 *
 * Independent of the service cap because the two counts are independent: a 200-service estate
 * where each component provides four interfaces is 800 entities, and the definitions are the
 * large half of the payload. Whatever this drops is COUNTED as a skipped interface, so a service
 * never appears to publish fewer interfaces than it does without the number saying so.
 */
const MAX_API_REFS = 600

/** How many bytes one response may carry before it is refused. */
const MAX_RESPONSE_BYTES = 8_000_000

export interface BackstageCatalogClientOptions {
  /** The portal's base URL, already normalised and validated at the write boundary. */
  baseUrl: string
  auth: ServiceCatalogAuth
  /**
   * The deployment's URL policy. A self-hosted portal is very often on a private or `.internal`
   * host, so this is the seam that makes reaching one an operator decision rather than something
   * the integration decides for itself: the strict default refuses it and a widened policy admits
   * exactly the hosts named.
   */
  urlPolicy?: UrlSafetyPolicy
  clock?: { now: () => number }
  logger?: Logger
  /** Injected for tests; the platform `fetch` otherwise. */
  fetchImpl?: typeof fetch
}

/** Reads a Backstage Software Catalog through the platform's neutral service-catalog port. */
export class BackstageCatalogClient implements ServiceCatalogClient {
  readonly provider: ServiceCatalogProvider = 'backstage'

  private readonly log: Logger

  constructor(private readonly options: BackstageCatalogClientOptions) {
    this.log = options.logger ?? noopLogger
  }

  async fetchCatalog(fetchOptions: ServiceCatalogFetchOptions): Promise<ServiceCatalogFetch> {
    // An empty filter is REFUSED rather than sent as "no filter", which the vendor reads as the
    // whole catalog. The write boundary substitutes a default for an empty one, so the only way to
    // arrive here with none is a connection row whose filter could not be read, and importing an
    // organisation's entire estate because its narrowing was lost is the one outcome worse than
    // failing. (`probe` deliberately asks unfiltered: it wants "can I read ANY entity".)
    if (fetchOptions.entityFilter.length === 0) {
      throw new UnavailableError(
        'This service-catalog connection has no entity filter, so there is nothing to import. Re-save the connection to restore its filter.',
        'service_catalog_filter_missing',
      )
    }
    const bearer = await this.resolveBearer()
    const listed = await this.listEntities(fetchOptions, bearer)
    const apis = fetchOptions.includeApis
      ? await this.resolveApis(listed.entities, bearer)
      : { byRef: new Map<string, ServiceCatalogApi>(), skipped: 0 }
    const entries: ServiceCatalogEntry[] = []
    const claimed = new Set<string>()
    let skippedEntries = listed.skipped
    let skippedApis = apis.skipped
    for (const entity of listed.entities) {
      const id = serviceIdForEntity(entity)
      // Two entities slugging onto one id is a real collision (a namespaced name whose prefix
      // collapses, a title-cased duplicate), and the first one wins rather than the last: an
      // import has to be STABLE across passes, and "last wins" would flip the survivor whenever
      // the portal paged them in a different order.
      if (!id || claimed.has(id)) {
        skippedEntries += 1
        continue
      }
      const refs = fetchOptions.includeApis ? providedApiRefs(entity) : []
      const resolved: ServiceCatalogApi[] = []
      for (const ref of refs) {
        const api = apis.byRef.get(ref)
        if (api) resolved.push(api)
        else skippedApis += 1
      }
      const entry = toServiceCatalogEntry(entity, resolved)
      if (!entry) {
        skippedEntries += 1
        continue
      }
      claimed.add(id)
      entries.push(entry)
    }
    return { entries, coverage: listed.coverage, skippedEntries, skippedApis }
  }

  async probe(): Promise<ConnectionTestResult> {
    try {
      const bearer = await this.resolveBearer()
      const page = await this.getJson(this.listUrl({ entityFilter: [] }, 1, null), bearer)
      // An EMPTY answer is reported as a connected-but-empty success rather than a failure: the
      // request was authorized and answered, and "this instance holds no entities the credential
      // may read" is a different problem from "the platform cannot reach it" with a different fix.
      return {
        ok: true,
        message:
          readItems(page).length > 0
            ? 'Connected: the catalog answered and returned at least one entity.'
            : 'Connected, but the catalog returned no entities. Check that this instance holds entities and that the credential is allowed to read them.',
      }
    } catch (error) {
      return connectionFailureResult(error, {
        subject: 'the Backstage catalog API',
        target: this.base(),
      })
    }
  }

  /**
   * The bearer value every request in this pass carries, or null for the modes that need none.
   *
   * Resolved ONCE per pass, which is the whole reason it is a separate step: a legacy token has a
   * short expiry and an OAuth2 exchange is a round trip, so minting or fetching per page would
   * multiply both the latency and the load on someone else's identity provider by the page count.
   */
  private async resolveBearer(): Promise<string | null> {
    const auth = this.options.auth
    if (!requiresResolvedBearer(auth.mode)) return null
    if (auth.mode === 'legacy-shared-secret') {
      return mintLegacyBackstageToken(auth.sharedSecret, Math.floor(this.now() / 1000))
    }
    if (auth.mode !== 'oauth2-client-credentials') return null
    assertSafePublicUrl(auth.tokenUrl, {
      subject: 'Backstage',
      label: 'OAuth token URL',
      ...(this.options.urlPolicy ? { policy: this.options.urlPolicy } : {}),
    })
    const response = await this.fetchSafely(auth.tokenUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
      },
      body: clientCredentialsBody(auth),
    })
    const text = await readCappedText(response, MAX_RESPONSE_BYTES, makeCatalogError, false)
    if (!response.ok) {
      throw upstream(
        `The identity provider refused the service-catalog client credentials (HTTP ${response.status}): ${snippet(text)}`,
        'service_catalog_unauthorized',
      )
    }
    const token = readAccessToken(parseJson(text))
    if (!token) {
      throw upstream(
        'The identity provider answered the service-catalog token request without an `access_token`.',
        'service_catalog_unauthorized',
      )
    }
    return token
  }

  /**
   * Walk the listing until the cap, the last page, or the page ceiling.
   *
   * Coverage is decided HERE rather than by comparing counts afterwards, because only this loop
   * knows WHY it stopped: a cursor still outstanding when the cap was reached is a truncation, and
   * the same entity count with no cursor left is a complete read of a small estate.
   */
  private async listEntities(
    fetchOptions: ServiceCatalogFetchOptions,
    bearer: string | null,
  ): Promise<{ entities: BackstageEntity[]; coverage: ServiceCatalogCoverage; skipped: number }> {
    const entities: BackstageEntity[] = []
    let skipped = 0
    let cursor: string | null = null
    let truncated = false
    for (let page = 0; page < MAX_PAGES; page++) {
      const remaining = fetchOptions.maxServices - entities.length
      if (remaining <= 0) {
        truncated = true
        break
      }
      const body = await this.getJson(
        this.listUrl(fetchOptions, Math.min(PAGE_SIZE, remaining), cursor),
        bearer,
      )
      for (const item of readItems(body)) {
        if (item && typeof item === 'object') entities.push(item as BackstageEntity)
        else skipped += 1
      }
      cursor = readNextCursor(body)
      if (!cursor) break
      if (page === MAX_PAGES - 1) truncated = true
    }
    if (cursor) truncated = true
    const coverage: ServiceCatalogCoverage =
      entities.length === 0 ? 'empty' : truncated ? 'truncated' : 'complete'
    return { entities, coverage, skipped }
  }

  /**
   * Every API entity the listed components declare, in batched requests, indexed by reference.
   *
   * Indexed rather than returned in order, because one interface is routinely provided by several
   * components and the portal answers a by-refs request positionally: a map is what lets the
   * caller attach the same definition to each provider without asking for it twice.
   */
  private async resolveApis(
    entities: BackstageEntity[],
    bearer: string | null,
  ): Promise<{ byRef: Map<string, ServiceCatalogApi>; skipped: number }> {
    const refs: string[] = []
    let skipped = 0
    for (const entity of entities) {
      for (const ref of providedApiRefs(entity)) {
        if (refs.includes(ref)) continue
        if (refs.length >= MAX_API_REFS) {
          skipped += 1
          continue
        }
        refs.push(ref)
      }
    }
    const byRef = new Map<string, ServiceCatalogApi>()
    for (let offset = 0; offset < refs.length; offset += REF_CHUNK) {
      const chunk = refs.slice(offset, offset + REF_CHUNK)
      const body = await this.postJson(
        `${this.base()}/api/catalog/entities/by-refs`,
        { entityRefs: chunk, fields: [...API_FETCH_FIELDS] },
        bearer,
      )
      // Positional against the refs we asked for: the vendor answers null for an entity that does
      // not exist (or that this credential may not read), and reading the answer by index is what
      // keeps a null attributed to the reference that produced it.
      for (const [index, item] of readItems(body).entries()) {
        const ref = chunk[index]
        if (!ref) continue
        const api = item && typeof item === 'object' ? toServiceCatalogApi(item) : null
        if (api) byRef.set(ref, api)
      }
    }
    return { byRef, skipped }
  }

  private listUrl(
    fetchOptions: Pick<ServiceCatalogFetchOptions, 'entityFilter'>,
    limit: number,
    cursor: string | null,
  ): string {
    const query = new URLSearchParams()
    // Comma-separated terms are the vendor's AND, and one `filter` parameter is what keeps this an
    // intersection: repeating the parameter would make the terms a UNION and silently widen an
    // operator's narrowing into the whole catalog.
    if (fetchOptions.entityFilter.length > 0) {
      query.set('filter', fetchOptions.entityFilter.join(','))
    }
    query.set('limit', String(limit))
    query.set('fields', CATALOG_LIST_FIELDS.join(','))
    if (cursor) query.set('cursor', cursor)
    return `${this.base()}/api/catalog/entities/by-query?${query.toString()}`
  }

  private base(): string {
    return this.options.baseUrl.replace(/\/+$/, '')
  }

  private now(): number {
    return this.options.clock?.now() ?? Date.now()
  }

  private async getJson(url: string, bearer: string | null): Promise<unknown> {
    const response = await this.fetchSafely(url, {
      method: 'GET',
      headers: { accept: 'application/json', ...this.authHeaders(bearer) },
    })
    return this.readJson(response, url)
  }

  private async postJson(url: string, body: unknown, bearer: string | null): Promise<unknown> {
    const response = await this.fetchSafely(url, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        ...this.authHeaders(bearer),
      },
      body: JSON.stringify(body),
    })
    return this.readJson(response, url)
  }

  private authHeaders(bearer: string | null): Record<string, string> {
    return serviceCatalogAuthHeaders(this.options.auth, bearer)
  }

  /**
   * `fetch` with the SSRF guard re-run on every redirect hop.
   *
   * The per-hop check is what a per-connection host needs and a host-pinned helper cannot give:
   * the base URL is operator-supplied, so a permitted first host could 302 the credential-bearing
   * request at a link-local metadata address. `safeFetch` also drops the body and the
   * `Authorization` header on a cross-origin hop, so a portal cannot bounce the token to a
   * different public host either.
   */
  private fetchSafely(url: string, init: RequestInit): Promise<Response> {
    const assertSafe = (candidate: string) =>
      assertSafePublicUrl(candidate, {
        subject: 'Backstage',
        label: 'catalog URL',
        ...(this.options.urlPolicy ? { policy: this.options.urlPolicy } : {}),
      })
    return safeFetch(url, init, assertSafe, makeCatalogError, undefined, this.options.fetchImpl)
  }

  private async readJson(response: Response, url: string): Promise<unknown> {
    const text = await readCappedText(response, MAX_RESPONSE_BYTES, makeCatalogError, false)
    if (!response.ok) {
      const reason =
        response.status === 401 || response.status === 403
          ? 'service_catalog_unauthorized'
          : 'service_catalog_unreachable'
      // The PATHNAME only: a catalog URL carries the filter and the cursor, and a cursor is an
      // opaque vendor token that has no business in a log line or an operator-facing message.
      this.log.warn('serviceCatalog.backstage.requestFailed', {
        status: response.status,
        path: pathOf(url),
      })
      throw upstream(
        `The Backstage catalog answered HTTP ${response.status}: ${snippet(text)}`,
        reason,
      )
    }
    const parsed = parseJson(text)
    if (parsed === null) {
      throw upstream(
        'The Backstage catalog answered with a body that is not JSON.',
        'service_catalog_unreachable',
      )
    }
    return parsed
  }
}

/** The `items` array a catalog response carries, or empty when it carries none. */
function readItems(body: unknown): unknown[] {
  const items = (body as { items?: unknown }).items
  return Array.isArray(items) ? items : []
}

/** The cursor the vendor's paged listing hands back, or null on the last page. */
function readNextCursor(body: unknown): string | null {
  const pageInfo = (body as { pageInfo?: { nextCursor?: unknown } }).pageInfo
  const cursor = pageInfo?.nextCursor
  return typeof cursor === 'string' && cursor ? cursor : null
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    // silent-catch-ok: the caller turns a null into a stated "not JSON" refusal that names the
    // portal, which is strictly more useful than the parser's own column number.
    return null
  }
}

/**
 * A bounded, SCRUBBED excerpt of what the portal said.
 *
 * Scrubbed because an error body is the one response that routinely echoes the request: a proxy's
 * 401 page can include the `Authorization` header it rejected, and this string reaches an operator
 * message and a log field.
 */
function snippet(text: string): string {
  const cleaned = redactSecrets(text.replace(/\s+/g, ' ').trim()) ?? ''
  if (!cleaned) return '(empty response)'
  return cleaned.length > 300 ? `${cleaned.slice(0, 300)}...` : cleaned
}

function pathOf(url: string): string {
  try {
    return new URL(url).pathname
  } catch {
    // silent-catch-ok: this is a log field, and an unparseable URL was already refused by the
    // guard above; a placeholder keeps the line emitting rather than failing the request.
    return '(unparseable)'
  }
}

/**
 * The refusal a portal failure raises: a 503 carrying the machine-readable reason, so the SPA maps
 * it to translated copy instead of rendering the vendor's prose as the whole explanation.
 */
function upstream(message: string, reason: string): Error {
  return new UnavailableError(message, reason)
}

/** The error shape `safeFetch` / `readCappedText` build for a blocked hop or an oversized body. */
function makeCatalogError(status: number, message: string): Error {
  return new UnavailableError(
    `Backstage catalog request failed (${status}): ${message}`,
    'service_catalog_unreachable',
  )
}
