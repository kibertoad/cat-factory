import {
  ConflictError,
  ValidationError,
  type DocumentContent,
  type DocumentCredentials,
  type DocumentSearchResult,
  type DocumentSourceProvider,
  type GitHubClient,
  type GitHubInstallationRepository,
  type NormalizedConnection,
} from '@cat-factory/kernel'
import { GITHUB_DOCS_DESCRIPTOR } from './github-docs.logic.js'
import * as githubDocsLogic from './github-docs.logic.js'

// GitHubDocsProvider: the document-source provider for files living in a GitHub
// repository (READMEs, RFCs, architecture notes under `docs/`). Like the
// GitHub-issues task source it stores NO per-workspace credentials — it reuses
// the workspace's installed GitHub App. The connection row is just a marker; the
// actual read resolves the installation that owns the file's repo by account
// login and fetches the file via the shared GitHubClient (installation token).
// GitHub serves these files as text, already Markdown-ish, so there is no
// body-conversion step. GitHub-specific *pure* logic (ref parsing, id
// round-tripping) lives in `@cat-factory/integrations`; this class is the thin
// `GitHubClient` shell.

/** Minimal structured logger (pino-shaped) for best-effort fetch diagnostics. */
export interface GitHubDocsLogger {
  warn(obj: Record<string, unknown>, msg?: string): void
}

export interface GitHubDocsProviderDependencies {
  githubClient: GitHubClient
  /** Resolves which installation owns a given repo owner (by account login). */
  installations: GitHubInstallationRepository
  /**
   * Optional structured logger. A failed doc read is logged with full coordinates
   * (workspace / owner / repo / path / HTTP status) so a "could not be linked"
   * report is diagnosable server-side — a domain error (409/422) is NOT otherwise
   * logged by the HTTP error handler (only unexpected 500s are).
   */
  logger?: GitHubDocsLogger
}

export class GitHubDocsProvider implements DocumentSourceProvider {
  readonly kind = 'github' as const
  readonly descriptor = GITHUB_DOCS_DESCRIPTOR

  constructor(private readonly deps: GitHubDocsProviderDependencies) {}

  /**
   * GitHub docs piggyback on the installed GitHub App, so there is nothing to
   * validate or persist — the connection is a marker. Any supplied fields are
   * ignored (the connect form has none).
   */
  normalizeConnection(_input: DocumentCredentials): NormalizedConnection {
    return { credentials: {}, label: 'GitHub' }
  }

  /**
   * GitHub docs ride the workspace's installed GitHub App, so the workspace is
   * connected to this source as soon as the App is installed — no separate connect
   * step or stored marker row. Resolve the workspace's installation to decide; absent
   * ⇒ null (the App isn't installed, so GitHub docs aren't reachable yet). Mirrors the
   * GitHub-issues task source's App-presence availability check.
   */
  async resolveImplicitConnection(workspaceId: string): Promise<NormalizedConnection | null> {
    const installation = await this.deps.installations.getByWorkspace(workspaceId)
    return installation ? { credentials: {}, label: 'GitHub' } : null
  }

  parseRef(input: string): string | null {
    return githubDocsLogic.parseGitHubDocRef(input)
  }

  async fetchDocument(
    _credentials: DocumentCredentials,
    externalId: string,
    workspaceId: string,
  ): Promise<DocumentContent> {
    const id = githubDocsLogic.parseGitHubDocExternalId(externalId)
    if (!id) {
      throw new ValidationError(`"${externalId}" is not a valid GitHub doc reference`)
    }
    const installationId = await this.resolveInstallationId(workspaceId, id.owner)
    const ref = { owner: id.owner, repo: id.repo }
    // Read the file's head commit sha FIRST (the version token), then read the body
    // pinned to that exact sha, so the (body, version) pair is consistent: two unpinned
    // parallel reads could straddle a commit and cache a stale body under a fresh
    // version the probe would then treat as current and never reload. The sha is
    // best-effort — a transient commits-API error (403 rate-limit, 5xx) must not fail
    // the whole fetch when the body reads fine, so it degrades to an empty version token
    // (which the cache treats as unverifiable ⇒ a TTL-bounded reload).
    const commitSha = await this.deps.githubClient
      .latestCommitSha(installationId, ref, id.path)
      .catch(() => null)
    let file: Awaited<ReturnType<GitHubClient['getFileContent']>>
    try {
      file = await this.deps.githubClient.getFileContent(
        installationId,
        ref,
        id.path,
        commitSha ?? undefined,
      )
    } catch (err) {
      // A raw GitHub API error (403 no-access, 429 rate-limit, 5xx) would otherwise
      // bubble up as an opaque 500 with the cause discarded. Classify it into a specific,
      // logged domain error so the failure names its remediation and carries context.
      throw this.fetchFailure(workspaceId, id, err)
    }
    if (!file) {
      // The read resolved to no file (the client maps a 404 to null): the doc is missing
      // on the default branch, or the installation/PAT can't see the repo at all.
      throw this.fetchFailure(workspaceId, id, null, true)
    }
    return {
      externalId: githubDocsLogic.githubDocExternalId(id),
      title: githubDocsLogic.githubDocTitle(id.path),
      url: githubDocsLogic.githubDocUrl(id),
      body: file.content,
      version: commitSha ?? '',
    }
  }

  /**
   * The cheap version probe: the head commit sha touching the file's path — one
   * commit-list read, no file body. Any commit to the file advances it, so an
   * unchanged sha means the doc body is still current.
   */
  async probeVersion(
    _credentials: DocumentCredentials,
    externalId: string,
    workspaceId: string,
  ): Promise<string> {
    const id = githubDocsLogic.parseGitHubDocExternalId(externalId)
    if (!id) {
      throw new ValidationError(`"${externalId}" is not a valid GitHub doc reference`)
    }
    const installationId = await this.resolveInstallationId(workspaceId, id.owner)
    const commitSha = await this.deps.githubClient.latestCommitSha(
      installationId,
      { owner: id.owner, repo: id.repo },
      id.path,
    )
    return commitSha ?? ''
  }

  async search(
    _credentials: DocumentCredentials,
    query: string,
    workspaceId: string,
  ): Promise<DocumentSearchResult[]> {
    // Scope to *this workspace's* installation so docs never leak across tenants
    // (a deployment may host many installations; a workspace owns exactly one).
    // Code search is account-scoped anyway (GitHub requires an org/user
    // qualifier), which we build from the installation's account.
    const installation = await this.deps.installations.getByWorkspace(workspaceId)
    if (!installation) return []
    const scoped = githubDocsLogic.buildGitHubCodeSearchQuery(
      query,
      installation.accountLogin,
      installation.targetType,
    )
    const hits = await this.deps.githubClient
      .searchCode(installation.installationId, scoped, 20)
      .catch(() => [])
    const out: DocumentSearchResult[] = []
    const seen = new Set<string>()
    for (const hit of hits) {
      const externalId = githubDocsLogic.githubDocExternalId({
        owner: hit.owner,
        repo: hit.repo,
        path: hit.path,
      })
      if (seen.has(externalId)) continue
      seen.add(externalId)
      out.push({
        source: 'github',
        externalId,
        title: githubDocsLogic.githubDocTitle(hit.path),
        url: hit.url,
        excerpt: '',
      })
    }
    return out.slice(0, 20)
  }

  /**
   * Resolve the installation to read `owner`'s repo with, scoped to THIS workspace.
   * A workspace owns exactly one installation, and every repo it can reach lives
   * under that installation's account — so the doc's `owner` must match the
   * workspace's own installation account. Resolving via `getByWorkspace` (not a
   * deployment-wide `listActive` scan by owner) is what stops a crafted `externalId`
   * from reaching another tenant's repo through some other workspace's installation
   * token — the same tenant-isolation `search` already enforces.
   */
  private async resolveInstallationId(workspaceId: string, owner: string): Promise<number> {
    const installation = await this.deps.installations.getByWorkspace(workspaceId)
    if (!installation) {
      throw new ConflictError(
        `Workspace '${workspaceId}' has no GitHub installation. Install the GitHub App (or set a PAT in local mode) to link its docs.`,
      )
    }
    if (installation.accountLogin.toLowerCase() !== owner.toLowerCase()) {
      throw new ConflictError(
        `GitHub doc "${owner}" is outside this workspace's installation (${installation.accountLogin}).`,
      )
    }
    return installation.installationId
  }

  /**
   * Turn a failed file read into a specific, logged {@link ConflictError}. Reads the GitHub
   * HTTP status structurally (no dependency on the concrete client error class), picks a
   * remediation-naming message, logs the full coordinates for server-side debugging, and
   * carries the coordinates + status on `details` so the client can surface/copy them.
   */
  private fetchFailure(
    workspaceId: string,
    id: githubDocsLogic.GitHubDocExternalId,
    err: unknown,
    notFound = false,
  ): ConflictError {
    const status = err !== null ? githubDocsLogic.githubErrorStatus(err) : undefined
    const underlying =
      err instanceof Error
        ? err.message
        : err !== null && err !== undefined
          ? String(err)
          : undefined
    const message = githubDocsLogic.describeGitHubDocFetchFailure(id, {
      status,
      notFound,
      underlying,
    })
    this.deps.logger?.warn(
      {
        source: 'github',
        workspaceId,
        owner: id.owner,
        repo: id.repo,
        path: id.path,
        status,
        notFound,
        err: underlying,
      },
      'github doc fetch failed',
    )
    return new ConflictError(message, undefined, {
      owner: id.owner,
      repo: id.repo,
      path: id.path,
      ...(status !== undefined ? { status } : {}),
    })
  }
}
