import {
  ValidationError,
  type DocumentContent,
  type DocumentCredentials,
  type DocumentSourceProvider,
  type NormalizedConnection,
} from '@cat-factory/kernel'
import { renderDesignContext } from './design.logic.js'
import { DocumentHttpError, createHostPinnedFetch, readCappedText } from './http.js'
import {
  ZEPLIN_API_HOST,
  ZEPLIN_DESCRIPTOR,
  buildZeplinDesignContext,
  parseZeplinRef,
  splitZeplinExternalId,
  type ZeplinComponent,
  type ZeplinDesignTokens,
  type ZeplinScreen,
} from './zeplin.logic.js'

// ZeplinProvider: the document-source provider for Zeplin, the design→dev handoff tool.
// It authenticates with a per-workspace personal access token (`Authorization: Bearer`),
// reads a project's screens + design-system (components + tokens) over the REST API, and
// maps them into the shared `DesignContext` the planner + `.cat-context/` materialisation
// consume. All Zeplin-specific *pure* logic (ref parsing, the host-pin guard, the JSON →
// DesignContext mapping) lives in `zeplin.logic.ts`; this class is the thin `fetch` shell.
//
// PROVISIONAL API SHAPE: the endpoint paths below target the documented Zeplin REST API;
// the host is pinned and the mapping is unit-tested independent of the network, but the
// exact paths/field names should be re-verified against docs.zeplin.dev when built —
// treat them as the intended shape, not a frozen contract (mirrors Figma's note).

const API_BASE = `https://${ZEPLIN_API_HOST}/v1`
const USER_AGENT = 'cat-factory'
/** Hard cap on the bytes read off any response body, to protect the isolate. */
const MAX_RESPONSE_BYTES = 5_000_000
/** Bound how many screens we pull for a whole-project import. */
const MAX_SCREENS = 40

/** Carries the HTTP status so callers can surface a meaningful error. */
export class ZeplinApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = 'ZeplinApiError'
  }
}

const safeFetch = createHostPinnedFetch({ host: ZEPLIN_API_HOST, label: 'Zeplin' })

export class ZeplinProvider implements DocumentSourceProvider {
  readonly kind = 'zeplin' as const
  readonly descriptor = ZEPLIN_DESCRIPTOR

  normalizeConnection(input: DocumentCredentials): NormalizedConnection {
    const apiToken = input.apiToken?.trim()
    if (!apiToken) {
      throw new ValidationError('Zeplin requires a personal access token')
    }
    return { credentials: { apiToken }, label: 'Zeplin' }
  }

  parseRef(input: string): string | null {
    return parseZeplinRef(input)
  }

  async fetchDocument(
    credentials: DocumentCredentials,
    externalId: string,
  ): Promise<DocumentContent> {
    const { projectId, screenId } = splitZeplinExternalId(externalId)
    if (!projectId) {
      throw new ZeplinApiError(400, `Zeplin ref is missing a project id: ${externalId}`)
    }

    // Primary read: validates the token + that the project exists (throws on a bad token).
    const project = await this.get<{ name?: string }>(
      credentials,
      `/projects/${encodeURIComponent(projectId)}`,
    )

    // The screens, components and tokens are best-effort: a single unreadable section is
    // dropped from the rendered context rather than failing the whole import.
    const screens = await this.fetchScreens(credentials, projectId, screenId)
    const components = await this.bestEffort(() =>
      this.get<ZeplinComponent[] | { components?: ZeplinComponent[] }>(
        credentials,
        `/projects/${encodeURIComponent(projectId)}/components`,
      ),
    )
    const designTokens = await this.bestEffort(() =>
      this.get<ZeplinDesignTokens>(
        credentials,
        `/projects/${encodeURIComponent(projectId)}/design_tokens`,
      ),
    )

    const context = buildZeplinDesignContext({
      externalId,
      projectName: project.name ?? projectId,
      screens,
      components: asArray<ZeplinComponent>(components, 'components'),
      designTokens,
    })

    return {
      externalId,
      title: context.title,
      url: context.url,
      body: renderDesignContext(context),
    }
  }

  /** Fetch the single referenced screen, or a bounded list of the project's screens. */
  private async fetchScreens(
    credentials: DocumentCredentials,
    projectId: string,
    screenId: string | undefined,
  ): Promise<ZeplinScreen[]> {
    if (screenId) {
      const screen = await this.bestEffort(() =>
        this.get<ZeplinScreen>(
          credentials,
          `/projects/${encodeURIComponent(projectId)}/screens/${encodeURIComponent(screenId)}`,
        ),
      )
      return screen ? [screen] : []
    }
    const listed = await this.bestEffort(() =>
      this.get<ZeplinScreen[] | { screens?: ZeplinScreen[] }>(
        credentials,
        `/projects/${encodeURIComponent(projectId)}/screens?limit=${MAX_SCREENS}`,
      ),
    )
    return asArray<ZeplinScreen>(listed, 'screens')
  }

  private async bestEffort<T>(fn: () => Promise<T>): Promise<T | null> {
    try {
      return await fn()
    } catch {
      return null
    }
  }

  private headers(credentials: DocumentCredentials): Record<string, string> {
    return {
      authorization: `Bearer ${credentials.apiToken ?? ''}`,
      accept: 'application/json',
      'user-agent': USER_AGENT,
    }
  }

  private async get<T>(credentials: DocumentCredentials, path: string): Promise<T> {
    const url = `${API_BASE}${path}`
    let res: Response
    try {
      res = await safeFetch(url, { method: 'GET', headers: this.headers(credentials) })
    } catch (err) {
      if (err instanceof DocumentHttpError) throw new ZeplinApiError(err.status, err.message)
      throw err
    }
    if (!res.ok) {
      const text = await readCappedText(res, MAX_RESPONSE_BYTES, 'Zeplin').catch(() => '')
      throw new ZeplinApiError(res.status, `Zeplin GET ${url} → ${res.status}: ${text.slice(0, 300)}`)
    }
    const text = await readCappedText(res, MAX_RESPONSE_BYTES, 'Zeplin')
    try {
      return JSON.parse(text) as T
    } catch {
      throw new ZeplinApiError(502, `Zeplin returned an unparseable body for ${path}`)
    }
  }
}

/** Accept either a bare array or a `{ <key>: [...] }` envelope, else an empty array. */
function asArray<T>(value: unknown, key: string): T[] {
  if (Array.isArray(value)) return value as T[]
  if (value && typeof value === 'object') {
    const inner = (value as Record<string, unknown>)[key]
    if (Array.isArray(inner)) return inner as T[]
  }
  return []
}
