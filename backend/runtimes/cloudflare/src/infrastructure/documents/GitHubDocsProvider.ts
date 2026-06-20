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
import { GITHUB_DOCS_DESCRIPTOR, githubDocsLogic } from '@cat-factory/integrations'

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

export interface GitHubDocsProviderDependencies {
  githubClient: GitHubClient
  /** Resolves which installation owns a given repo owner (by account login). */
  installations: GitHubInstallationRepository
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

  parseRef(input: string): string | null {
    return githubDocsLogic.parseGitHubDocRef(input)
  }

  async fetchDocument(
    _credentials: DocumentCredentials,
    externalId: string,
  ): Promise<DocumentContent> {
    const id = githubDocsLogic.parseGitHubDocExternalId(externalId)
    if (!id) {
      throw new ValidationError(`"${externalId}" is not a valid GitHub doc reference`)
    }
    const installationId = await this.resolveInstallationId(id.owner)
    const file = await this.deps.githubClient.getFileContent(
      installationId,
      { owner: id.owner, repo: id.repo },
      id.path,
    )
    if (!file) {
      throw new ConflictError(`GitHub file "${id.path}" was not found in ${id.owner}/${id.repo}`)
    }
    return {
      externalId: githubDocsLogic.githubDocExternalId(id),
      title: githubDocsLogic.githubDocTitle(id.path),
      url: githubDocsLogic.githubDocUrl(id),
      body: file.content,
    }
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
   * Find the GitHub App installation whose account owns `owner`. The
   * installation token for that account is what can read the repo's contents,
   * regardless of which workspace triggered the import.
   */
  private async resolveInstallationId(owner: string): Promise<number> {
    const active = await this.deps.installations.listActive()
    const match = active.find((i) => i.accountLogin.toLowerCase() === owner.toLowerCase())
    if (!match) {
      throw new ConflictError(
        `No GitHub App installation found for "${owner}". Install the GitHub App on that account to link its docs.`,
      )
    }
    return match.installationId
  }
}
