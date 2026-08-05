import {
  ValidationError,
  type DocumentContent,
  type DocumentCredentials,
  type DocumentSourceProvider,
  type NormalizedConnection,
} from '@cat-factory/kernel'
import { renderDesignContext } from './design.logic.js'
import { FIGMA_API_HOST, FIGMA_DESCRIPTOR } from './figma.logic.js'
import * as figmaLogic from './figma.logic.js'
import { DocumentHttpError, createHostPinnedFetch, readCappedText } from './http.js'

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
/**
 * Depth of the whole-file OUTLINE read: `depth=2` returns the pages and their top-level
 * frames with no grandchildren, which is how we learn the frame ids. The content then comes
 * from per-frame node reads below, because a deeper `depth=` on the file endpoint fetches
 * the entire document at once and blows the response cap on any real file.
 */
const FILE_DEPTH = 2
/** Depth requested per frame subtree: one level past what the layout renderer will show. */
const FRAME_DEPTH = 7
/** Frames per `/nodes` request: bounded so one oversize response can't cost every frame. */
const FRAME_CHUNK = 4
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

/** The design-system maps Figma returns beside a node tree, on both endpoints. */
interface FigmaMaps {
  components?: figmaLogic.FigmaComponentMap
  componentSets?: figmaLogic.FigmaComponentSetMap
  styles?: figmaLogic.FigmaStyleMap
}

interface FileResponse extends FigmaMaps {
  name?: string
  /** File version id / last-modified timestamp Figma advances on every edit. */
  version?: string
  lastModified?: string
  document?: figmaLogic.FigmaNode
}

interface NodesResponse {
  name?: string
  version?: string
  lastModified?: string
  nodes?: Record<string, ({ document?: figmaLogic.FigmaNode } & FigmaMaps) | undefined>
}

/** Everything one fetch of a file/frame yields: the trees, the maps, and what it dropped. */
interface FetchedNodes {
  roots: figmaLogic.FigmaNode[]
  maps: Required<FigmaMaps>
  fileName: string
  version: string
  notes: string[]
}

/** The variables read is three-valued: a 403 is a PLAN GATE, not a failure. */
type VariablesRead =
  | { status: 'ok'; meta: figmaLogic.FigmaVariablesMeta | null }
  | { status: 'gated' }
  | { status: 'failed' }

function emptyMaps(): Required<FigmaMaps> {
  return { components: {}, componentSets: {}, styles: {} }
}

/** Fold one response's design-system maps onto the accumulated ones. */
function mergeMaps(into: Required<FigmaMaps>, from: FigmaMaps | undefined): void {
  Object.assign(into.components, from?.components ?? {})
  Object.assign(into.componentSets, from?.componentSets ?? {})
  Object.assign(into.styles, from?.styles ?? {})
}

interface VariablesResponse {
  meta?: figmaLogic.FigmaVariablesMeta
}

interface ImagesResponse {
  images?: Record<string, string | null>
  err?: string | null
}

/** Figma's file `version` (falling back to `lastModified`) as the staleness token. */
function fileVersion(res: { version?: string; lastModified?: string }): string {
  return res.version ?? res.lastModified ?? ''
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
    _workspaceId: string,
  ): Promise<DocumentContent> {
    const { fileKey, nodeId } = figmaLogic.splitFigmaExternalId(externalId)
    if (!fileKey) {
      throw new FigmaApiError(400, `Figma ref is missing a file key: ${externalId}`)
    }

    const { roots, maps, fileName, version, notes } = await this.fetchNodes(
      credentials,
      fileKey,
      nodeId,
    )
    // Design tokens are Enterprise-gated; on 403/404 the published styles carried by the
    // node tree are the fallback and the render says which one it used. A rendered preview
    // rides along as a reference (no download): best-effort, the short-lived URL may expire
    // and a non-multimodal agent ignores it.
    const variables = await this.fetchVariables(credentials, fileKey)
    const previewUrl = await this.fetchPreviewUrl(credentials, fileKey, nodeId)

    const context = figmaLogic.buildFigmaDesignContext({
      externalId,
      fileName,
      nodeId,
      roots,
      components: maps.components,
      componentSets: maps.componentSets,
      styles: maps.styles,
      variablesMeta: variables.status === 'ok' ? variables.meta : null,
      variablesStatus: variables.status,
      previewUrl,
      fetchNotes: notes,
    })

    return {
      externalId,
      title: context.title,
      url: context.url,
      body: renderDesignContext(context),
      version,
    }
  }

  /**
   * The cheap version probe: read the file's metadata at `depth=1` (no node tree)
   * for its `version` / `lastModified`, skipping the deep node fetch + variables +
   * preview render a full document fetch performs.
   */
  async probeVersion(
    credentials: DocumentCredentials,
    externalId: string,
    _workspaceId: string,
  ): Promise<string> {
    const { fileKey } = figmaLogic.splitFigmaExternalId(externalId)
    if (!fileKey) {
      throw new FigmaApiError(400, `Figma ref is missing a file key: ${externalId}`)
    }
    const res = await this.get<FileResponse>(
      credentials,
      `/files/${encodeURIComponent(fileKey)}?depth=1`,
    )
    return fileVersion(res)
  }

  /** Fetch a specific node's subtree, or the whole file's frames, plus its design-system maps. */
  private async fetchNodes(
    credentials: DocumentCredentials,
    fileKey: string,
    nodeId: string | undefined,
  ): Promise<FetchedNodes> {
    if (nodeId) return await this.fetchNodeSubtree(credentials, fileKey, nodeId)
    return await this.fetchFileFrames(credentials, fileKey)
  }

  /** A node link: one `/nodes` read of the referenced frame's full subtree. */
  private async fetchNodeSubtree(
    credentials: DocumentCredentials,
    fileKey: string,
    nodeId: string,
  ): Promise<FetchedNodes> {
    const res = await this.get<NodesResponse>(
      credentials,
      `/files/${encodeURIComponent(fileKey)}/nodes?ids=${encodeURIComponent(nodeId)}`,
    )
    const entry = res.nodes?.[nodeId]
    if (!entry?.document) {
      throw new FigmaApiError(404, `Figma node ${nodeId} not found in file ${fileKey}`)
    }
    const maps = emptyMaps()
    mergeMaps(maps, entry)
    return {
      roots: [entry.document],
      maps,
      fileName: res.name ?? fileKey,
      version: fileVersion(res),
      notes: [],
    }
  }

  /**
   * A whole-file link: read the file's OUTLINE (pages + top-level frames, no grandchildren),
   * then fetch a bounded set of those frames as real subtrees. A single `depth=` bump on the
   * file endpoint cannot do this: Figma returns pages and their top-level frames with no
   * children at `depth=2`, and the whole document at a depth that would reach the content.
   *
   * A frame whose subtree read fails still renders from the outline, and every frame the
   * cap or a failure cost is NAMED, so a bounded import can't read as the whole design.
   */
  private async fetchFileFrames(
    credentials: DocumentCredentials,
    fileKey: string,
  ): Promise<FetchedNodes> {
    const res = await this.get<FileResponse>(
      credentials,
      `/files/${encodeURIComponent(fileKey)}?depth=${FILE_DEPTH}`,
    )
    if (!res.document) {
      throw new FigmaApiError(502, `Figma returned no document for file ${fileKey}`)
    }
    const maps = emptyMaps()
    mergeMaps(maps, res)

    const outline = figmaLogic.figmaTopLevelFrames(res.document)
    const base: FetchedNodes = {
      // A file with no frames at all (an empty document) still renders its own root, which
      // is what the outline-only fallback did before frames were fetched separately.
      roots: outline.length ? outline : [res.document],
      maps,
      fileName: res.name ?? fileKey,
      version: fileVersion(res),
      notes: [],
    }
    if (!outline.length) return base

    const selected = outline.slice(0, figmaLogic.MAX_FILE_FRAMES)
    if (selected.length < outline.length) {
      base.notes.push(
        `This file has ${outline.length} top-level frames; the first ${selected.length} were ` +
          `imported. Link a specific frame URL to import one that is not listed here.`,
      )
    }

    const deep = await this.fetchFrameSubtrees(credentials, fileKey, selected, maps)
    base.roots = selected.map((frame) => (frame.id ? (deep.get(frame.id) ?? frame) : frame))
    const unread = selected.length - deep.size
    if (unread > 0) {
      base.notes.push(
        `${unread} of ${selected.length} frame subtree reads failed; those frames show their ` +
          `name and size only, not their layout or text.`,
      )
    }
    return base
  }

  /**
   * Read the selected frames' subtrees in chunks, folding each response's design-system maps
   * in. Chunked so one oversize response costs its own frames rather than every frame, and
   * best-effort per chunk: the caller reports the frames a failure left at outline depth.
   */
  private async fetchFrameSubtrees(
    credentials: DocumentCredentials,
    fileKey: string,
    frames: figmaLogic.FigmaNode[],
    maps: Required<FigmaMaps>,
  ): Promise<Map<string, figmaLogic.FigmaNode>> {
    const out = new Map<string, figmaLogic.FigmaNode>()
    for (let i = 0; i < frames.length; i += FRAME_CHUNK) {
      const ids = frames
        .slice(i, i + FRAME_CHUNK)
        .map((frame) => frame.id)
        .filter((id): id is string => Boolean(id))
      if (!ids.length) continue
      let res: NodesResponse
      try {
        res = await this.get<NodesResponse>(
          credentials,
          `/files/${encodeURIComponent(fileKey)}/nodes` +
            `?ids=${encodeURIComponent(ids.join(','))}&depth=${FRAME_DEPTH}`,
        )
      } catch {
        // silent-catch-ok: the miss is REPORTED by the caller as the frames left at outline
        // depth, which is the honest form of it; a failed chunk must not fail the import.
        continue
      }
      for (const id of ids) {
        const entry = res.nodes?.[id]
        if (!entry?.document) continue
        mergeMaps(maps, entry)
        out.set(id, entry.document)
      }
    }
    return out
  }

  /**
   * Fetch the local-variables `meta` (design tokens). A 403/404 is the Enterprise PLAN GATE
   * and is reported as `gated` rather than as a failure, because the render says which of
   * the two happened. Fully best-effort either way: any transport failure (incl. a
   * blocked-redirect `DocumentHttpError`) drops the tokens rather than failing the import.
   */
  private async fetchVariables(
    credentials: DocumentCredentials,
    fileKey: string,
  ): Promise<VariablesRead> {
    try {
      const res = await safeFetch(
        `${API_BASE}/files/${encodeURIComponent(fileKey)}/variables/local`,
        { method: 'GET', headers: this.headers(credentials) },
      )
      if (res.status === 403 || res.status === 404) return { status: 'gated' }
      if (!res.ok) return { status: 'failed' }
      const json = this.parse<VariablesResponse>(await readCappedText(res, MAX_RESPONSE_BYTES))
      return json ? { status: 'ok', meta: json.meta ?? null } : { status: 'failed' }
    } catch {
      // silent-catch-ok: reported as the `failed` status, which the token origin states in
      // the rendered body; the variables read may never fail the import.
      return { status: 'failed' }
    }
  }

  /** Best-effort short-lived PNG render URL for the node (or whole file); null on any failure. */
  private async fetchPreviewUrl(
    credentials: DocumentCredentials,
    fileKey: string,
    nodeId: string | undefined,
  ): Promise<string | null> {
    if (!nodeId) return null
    try {
      const res = await safeFetch(
        `${API_BASE}/images/${encodeURIComponent(fileKey)}?ids=${encodeURIComponent(nodeId)}&format=png`,
        { method: 'GET', headers: this.headers(credentials) },
      )
      if (!res.ok) return null
      const json = this.parse<ImagesResponse>(await readCappedText(res, MAX_RESPONSE_BYTES))
      if (!json || json.err) return null
      const url = json.images?.[nodeId]
      return typeof url === 'string' ? url : null
    } catch {
      return null
    }
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
    let res: Response
    try {
      res = await safeFetch(url, { method: 'GET', headers: this.headers(credentials) })
    } catch (err) {
      // The shared transport raises DocumentHttpError on a blocked/off-host redirect;
      // surface it as the provider's own error type so callers see one shape.
      if (err instanceof DocumentHttpError) throw new FigmaApiError(err.status, err.message)
      throw err
    }
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
