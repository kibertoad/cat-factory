import {
  ValidationError,
  type DocumentContent,
  type DocumentCredentials,
  type DocumentSourceProvider,
  type NormalizedConnection,
} from '@cat-factory/kernel'
import {
  CLAUDE_DESIGN_API_HOST,
  CLAUDE_DESIGN_DESCRIPTOR,
  DS_MANIFEST_PATH,
  claudeDesignUrlFor,
  parseClaudeDesignRef,
  renderClaudeDesignProject,
  splitClaudeDesignExternalId,
  type ClaudeDesignFile,
} from './claudeDesign.logic.js'
import { DocumentHttpError, createHostPinnedFetch, readCappedText } from './http.js'

// ClaudeDesignProvider: the document-source provider for Anthropic's Claude Design. It
// authenticates with a **per-user** personal access token (the credential is stored
// keyed by user id, not shared across the workspace — see the descriptor's
// `credentialScope: 'user'`), reads a design-system project's files over the REST API,
// and renders the component inventory + design tokens to the Markdown the planner +
// `.cat-context/` materialisation consume. All Claude-Design-specific *pure* logic (ref
// parsing, the host-pin guard, the HTML/manifest → Markdown normalizer) lives in
// `claudeDesign.logic.ts`; this class is the thin `fetch` shell.
//
// PROVISIONAL API SHAPE: the endpoint paths/headers below target the per-user-PAT read
// the product is moving toward (today the design-system read is claude.ai-login-bound).
// The host is pinned; re-verify the exact endpoints against the current API when the
// credentialed read ships — they are the intended shape, not a frozen contract. The
// normalizer they feed is solid and fully unit-tested regardless.

const API_BASE = `https://${CLAUDE_DESIGN_API_HOST}/v1`
const USER_AGENT = 'cat-factory'
/** Hard cap on the bytes read off any response body, to protect the isolate. */
const MAX_RESPONSE_BYTES = 5_000_000
/** Bound how many project files we pull for a whole-project import. */
const MAX_PROJECT_FILES = 12

/**
 * `fetch` pinned to the Claude Design host, following redirects by hand so the SSRF host
 * guard runs against every hop (a 302 can't chase the PAT off-host). Shared transport.
 */
const safeFetch = createHostPinnedFetch({ host: CLAUDE_DESIGN_API_HOST, label: 'Claude Design' })

interface FileListResponse {
  files?: ({ path?: string } | string)[]
  paths?: string[]
}

export class ClaudeDesignProvider implements DocumentSourceProvider {
  readonly kind = 'claude-design' as const
  readonly descriptor = CLAUDE_DESIGN_DESCRIPTOR

  normalizeConnection(input: DocumentCredentials): NormalizedConnection {
    const apiToken = input.apiToken?.trim()
    if (!apiToken) {
      throw new ValidationError('Claude Design requires a personal access token')
    }
    return { credentials: { apiToken }, label: 'Claude Design' }
  }

  parseRef(input: string): string | null {
    return parseClaudeDesignRef(input)
  }

  async fetchDocument(
    credentials: DocumentCredentials,
    externalId: string,
  ): Promise<DocumentContent> {
    const { projectId, filePath } = splitClaudeDesignExternalId(externalId)
    if (!projectId) {
      throw new DocumentHttpError(400, `Claude Design ref is missing a project id: ${externalId}`)
    }

    const files = filePath
      ? [{ path: filePath, content: await this.fetchFile(credentials, projectId, filePath) }]
      : await this.fetchProjectFiles(credentials, projectId)

    const projectName = this.deriveName(projectId, filePath, files)
    const body = renderClaudeDesignProject(projectName, files)

    return {
      externalId,
      title: projectName,
      url: claudeDesignUrlFor(externalId),
      body,
    }
  }

  /** List a project's files, then fetch the manifest + a bounded slice of HTML previews. */
  private async fetchProjectFiles(
    credentials: DocumentCredentials,
    projectId: string,
  ): Promise<ClaudeDesignFile[]> {
    const listed = await this.get<FileListResponse>(
      credentials,
      `/design/projects/${encodeURIComponent(projectId)}/files`,
    )
    const paths = normalizePaths(listed)
    if (paths.length === 0) {
      throw new DocumentHttpError(404, `Claude Design project ${projectId} has no readable files`)
    }
    // The manifest is the authoritative index; then prefer component-preview HTML and any
    // stylesheet (for tokens), bounded so a huge project can't stall the import.
    const manifest = paths.filter((p) => p.endsWith(DS_MANIFEST_PATH))
    const styles = paths.filter((p) => /\.css$/i.test(p))
    const html = paths.filter((p) => /\.html?$/i.test(p))
    const chosen = [...manifest, ...styles, ...html].slice(0, MAX_PROJECT_FILES)

    const out: ClaudeDesignFile[] = []
    for (const path of chosen) {
      try {
        out.push({ path, content: await this.fetchFile(credentials, projectId, path) })
      } catch {
        // A single unreadable file shouldn't fail the whole import — skip it.
      }
    }
    if (out.length === 0) {
      throw new DocumentHttpError(
        502,
        `Claude Design project ${projectId} returned no file content`,
      )
    }
    return out
  }

  /** Fetch one file's textual content (raw, or unwrapped from a `{ content }` JSON body). */
  private async fetchFile(
    credentials: DocumentCredentials,
    projectId: string,
    path: string,
  ): Promise<string> {
    const url = `${API_BASE}/design/projects/${encodeURIComponent(projectId)}/files/${path
      .split('/')
      .map(encodeURIComponent)
      .join('/')}`
    const res = await safeFetch(url, { method: 'GET', headers: this.headers(credentials) })
    if (!res.ok) {
      const text = await readCappedText(res, MAX_RESPONSE_BYTES, 'Claude Design').catch(() => '')
      throw new DocumentHttpError(
        res.status,
        `Claude Design GET ${url} → ${res.status}: ${text.slice(0, 300)}`,
      )
    }
    const text = await readCappedText(res, MAX_RESPONSE_BYTES, 'Claude Design')
    // The files endpoint may return raw file bytes or a `{ content }` JSON envelope.
    const contentType = res.headers.get('content-type') ?? ''
    if (contentType.includes('application/json')) {
      try {
        const json = JSON.parse(text) as { content?: unknown }
        if (typeof json.content === 'string') return json.content
      } catch {
        // Not a JSON envelope after all — fall through and use the raw text.
      }
    }
    return text
  }

  /** Name the document: the manifest's `name`, else the file path, else the project id. */
  private deriveName(
    projectId: string,
    filePath: string | undefined,
    files: ClaudeDesignFile[],
  ): string {
    const manifest = files.find((f) => f.path.endsWith(DS_MANIFEST_PATH))
    if (manifest) {
      try {
        const json = JSON.parse(manifest.content) as { name?: unknown }
        if (typeof json.name === 'string' && json.name.trim()) return json.name.trim()
      } catch {
        // ignore — fall through
      }
    }
    if (filePath) return `${projectId} — ${filePath}`
    return projectId
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
    const res = await safeFetch(url, { method: 'GET', headers: this.headers(credentials) })
    if (!res.ok) {
      const text = await readCappedText(res, MAX_RESPONSE_BYTES, 'Claude Design').catch(() => '')
      throw new DocumentHttpError(
        res.status,
        `Claude Design GET ${url} → ${res.status}: ${text.slice(0, 300)}`,
      )
    }
    const text = await readCappedText(res, MAX_RESPONSE_BYTES, 'Claude Design')
    try {
      return JSON.parse(text) as T
    } catch {
      throw new DocumentHttpError(502, `Claude Design returned an unparseable body for ${path}`)
    }
  }
}

/** Flatten the file-list response into a clean string[] of paths. */
function normalizePaths(listed: FileListResponse): string[] {
  const raw = listed.files ?? listed.paths ?? []
  const out: string[] = []
  for (const entry of raw) {
    const path = typeof entry === 'string' ? entry : entry?.path
    if (typeof path === 'string' && path.trim()) out.push(path.trim())
  }
  return out
}
