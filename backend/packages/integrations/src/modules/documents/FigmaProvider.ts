import {
  ValidationError,
  type DocumentContent,
  type DocumentCredentials,
  type DocumentSourceProvider,
  type NormalizedConnection,
} from '@cat-factory/kernel'
import { FIGMA_API_HOST, FIGMA_DESCRIPTOR } from './figma.logic.js'
import * as figmaLogic from './figma.logic.js'
import { createHostPinnedFetch, readCappedText } from './http.js'

// FigmaProvider: the document-source provider for Figma. It authenticates with a
// per-workspace personal access token (the `X-Figma-Token` header), fetches a
// file or a specific frame/node via the REST API, and renders the layout tree,
// text, components-used and (Enterprise-gated) design tokens to the Markdown the
// planner + `.cat-context/` materialisation consume. All Figma-specific *pure*
// logic (ref parsing, the fixed-host SSRF guard, JSON → Markdown) lives in
// `figma.logic.ts` so it is unit-testable; this class is the thin `fetch` shell.
// Because the API host is fixed (`api.figma.com`) and there is no per-site base
// URL, the only SSRF surface is a redirect off-host — guarded per hop below.

const API_BASE = 'https://api.figma.com/v1'
const USER_AGENT = 'cat-factory'
/** Depth fetched for a whole-file link (a node link fetches its own subtree). */
const FILE_DEPTH = 2
/** Hard cap on the bytes read off any response body, to protect the isolate. */
const MAX_RESPONSE_BYTES = 5_000_000

/** Carries the HTTP status so callers can surface a meaningful error. */
export class FigmaApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = 'FigmaApiError'
  }
}

/**
 * `fetch` pinned to `api.figma.com`, following redirects by hand so the SSRF host
 * guard runs against every hop (a 302 can't chase the PAT off-host). The transport +
 * capped-read are the shared documents `http` helpers; only the host/label differ.
 */
const safeFetch = createHostPinnedFetch({ host: FIGMA_API_HOST, label: 'Figma' })

interface FileResponse {
  name?: string
  document?: figmaLogic.FigmaNode
  components?: figmaLogic.FigmaComponentMap
}

interface NodesResponse {
  name?: string
  nodes?: Record<
    string,
    { document?: figmaLogic.FigmaNode; components?: figmaLogic.FigmaComponentMap } | undefined
  >
}

interface VariablesResponse {
  meta?: figmaLogic.FigmaVariablesMeta
}

interface ImagesResponse {
  images?: Record<string, string | null>
  err?: string | null
}

export class FigmaProvider implements DocumentSourceProvider {
  readonly kind = 'figma' as const
  readonly descriptor = FIGMA_DESCRIPTOR

  normalizeConnection(input: DocumentCredentials): NormalizedConnection {
    const apiToken = input.apiToken?.trim()
    if (!apiToken) {
      throw new ValidationError('Figma requires a personal access token')
    }
    return { credentials: { apiToken }, label: 'Figma' }
  }

  parseRef(input: string): string | null {
    return figmaLogic.parseFigmaRef(input)
  }

  async fetchDocument(
    credentials: DocumentCredentials,
    externalId: string,
  ): Promise<DocumentContent> {
    const { fileKey, nodeId } = figmaLogic.splitFigmaExternalId(externalId)
    if (!fileKey) {
      throw new FigmaApiError(400, `Figma ref is missing a file key: ${externalId}`)
    }

    const { roots, components, fileName } = await this.fetchNodes(credentials, fileKey, nodeId)
    const sections: string[] = [figmaLogic.figmaNodesToMarkdown(roots, components)]

    // Design tokens are Enterprise-gated; on 403/404 drop the section, don't fail.
    const tokens = await this.fetchVariables(credentials, fileKey)
    if (tokens) sections.push(tokens)

    // A rendered preview rides along as a reference line (no download). Best-effort:
    // a non-multimodal agent ignores it and the short-lived URL may expire.
    const preview = await this.fetchPreviewUrl(credentials, fileKey, nodeId)
    if (preview) sections.push(`### Rendered preview\nRendered preview: ${preview}`)

    const title = nodeId ? `${fileName} — ${roots[0]?.name?.trim() || nodeId}` : fileName || fileKey

    return {
      externalId,
      title,
      url: figmaLogic.figmaUrlFor(externalId),
      body: sections.filter(Boolean).join('\n\n').trim(),
    }
  }

  /** Fetch a specific node's subtree, or the whole file's document, plus its components. */
  private async fetchNodes(
    credentials: DocumentCredentials,
    fileKey: string,
    nodeId: string | undefined,
  ): Promise<{
    roots: figmaLogic.FigmaNode[]
    components: figmaLogic.FigmaComponentMap
    fileName: string
  }> {
    if (nodeId) {
      const res = await this.get<NodesResponse>(
        credentials,
        `/files/${encodeURIComponent(fileKey)}/nodes?ids=${encodeURIComponent(nodeId)}`,
      )
      const entry = res.nodes?.[nodeId]
      if (!entry?.document) {
        throw new FigmaApiError(404, `Figma node ${nodeId} not found in file ${fileKey}`)
      }
      return {
        roots: [entry.document],
        components: entry.components ?? {},
        fileName: res.name ?? fileKey,
      }
    }
    const res = await this.get<FileResponse>(
      credentials,
      `/files/${encodeURIComponent(fileKey)}?depth=${FILE_DEPTH}`,
    )
    if (!res.document) {
      throw new FigmaApiError(502, `Figma returned no document for file ${fileKey}`)
    }
    // For a whole-file link the document's children are the pages/canvases; render
    // each top-level frame under them as a section root.
    const roots = (res.document.children ?? []).flatMap((page) => page.children ?? [])
    return {
      roots: roots.length ? roots : [res.document],
      components: res.components ?? {},
      fileName: res.name ?? fileKey,
    }
  }

  /** Fetch local variables (design tokens); null on the Enterprise-gating 403/404. */
  private async fetchVariables(
    credentials: DocumentCredentials,
    fileKey: string,
  ): Promise<string | null> {
    const res = await safeFetch(
      `${API_BASE}/files/${encodeURIComponent(fileKey)}/variables/local`,
      { method: 'GET', headers: this.headers(credentials) },
    )
    if (res.status === 403 || res.status === 404) return null
    if (!res.ok) return null
    const json = this.parse<VariablesResponse>(await readCappedText(res, MAX_RESPONSE_BYTES))
    const markdown = figmaLogic.figmaVariablesToMarkdown(json?.meta)
    return markdown || null
  }

  /** Best-effort short-lived PNG render URL for the node (or whole file); null on any failure. */
  private async fetchPreviewUrl(
    credentials: DocumentCredentials,
    fileKey: string,
    nodeId: string | undefined,
  ): Promise<string | null> {
    if (!nodeId) return null
    const res = await safeFetch(
      `${API_BASE}/images/${encodeURIComponent(fileKey)}?ids=${encodeURIComponent(nodeId)}&format=png`,
      { method: 'GET', headers: this.headers(credentials) },
    )
    if (!res.ok) return null
    const json = this.parse<ImagesResponse>(await readCappedText(res, MAX_RESPONSE_BYTES))
    if (!json || json.err) return null
    const url = json.images?.[nodeId]
    return typeof url === 'string' ? url : null
  }

  private headers(credentials: DocumentCredentials): Record<string, string> {
    return {
      'x-figma-token': credentials.apiToken ?? '',
      accept: 'application/json',
      'user-agent': USER_AGENT,
    }
  }

  private parse<T>(text: string): T | null {
    try {
      return JSON.parse(text) as T
    } catch {
      return null
    }
  }

  private async get<T>(credentials: DocumentCredentials, path: string): Promise<T> {
    const url = `${API_BASE}${path}`
    const res = await safeFetch(url, { method: 'GET', headers: this.headers(credentials) })
    if (!res.ok) {
      const text = await readCappedText(res, MAX_RESPONSE_BYTES).catch(() => '')
      throw new FigmaApiError(res.status, `Figma GET ${url} → ${res.status}: ${text.slice(0, 300)}`)
    }
    const json = this.parse<T>(await readCappedText(res, MAX_RESPONSE_BYTES))
    if (json === null) {
      throw new FigmaApiError(502, `Figma returned an unparseable body for ${path}`)
    }
    return json
  }
}
