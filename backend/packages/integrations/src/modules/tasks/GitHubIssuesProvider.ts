import {
  ConflictError,
  ValidationError,
  type GitHubClient,
  type GitHubInstallationRepository,
  type TaskContent,
  type TaskCredentials,
  type TaskSearchResult,
  type TaskSourceProvider,
  type NormalizedTaskConnection,
} from '@cat-factory/kernel'
import { GITHUB_ISSUES_DESCRIPTOR } from './github-issues.logic.js'
import * as githubIssuesLogic from './github-issues.logic.js'

// GitHubIssuesProvider: the task-source provider for GitHub issues. Unlike Jira,
// it stores NO per-workspace credentials — it reuses the workspace's installed
// GitHub App. The connection row is just a marker (so the source shows as
// "connected" and the generic import flow runs); the actual fetch resolves the
// installation that owns the issue's repo by account login and reads the issue
// via the shared GitHubClient (installation token). GitHub issue bodies are
// already Markdown, so no body conversion is needed.
//
// Runtime-neutral: it depends only on the kernel ports (GitHubClient,
// GitHubInstallationRepository) and the shared pure logic, so both the Cloudflare
// and the Node facade wire the SAME class (see CLAUDE.md "Keep the runtimes
// symmetric").

export interface GitHubIssuesProviderDependencies {
  githubClient: GitHubClient
  /** Resolves which installation owns a given repo owner (by account login). */
  installations: GitHubInstallationRepository
}

export class GitHubIssuesProvider implements TaskSourceProvider {
  readonly kind = 'github' as const
  readonly descriptor = GITHUB_ISSUES_DESCRIPTOR

  constructor(private readonly deps: GitHubIssuesProviderDependencies) {}

  /**
   * GitHub issues piggyback on the installed GitHub App, so there is nothing to
   * validate or persist — the connection is a marker. Any supplied fields are
   * ignored (the connect form has none).
   */
  normalizeConnection(_input: TaskCredentials): NormalizedTaskConnection {
    return { credentials: {}, label: 'GitHub' }
  }

  parseRef(input: string): string | null {
    return githubIssuesLogic.parseGitHubIssueRef(input)
  }

  async fetchTask(_credentials: TaskCredentials, externalId: string): Promise<TaskContent> {
    const id = githubIssuesLogic.parseGitHubIssueExternalId(externalId)
    if (!id) {
      throw new ValidationError(`"${externalId}" is not a valid GitHub issue reference`)
    }
    const installationId = await this.resolveInstallationId(id.owner)
    const detail = await this.deps.githubClient.getIssue(
      installationId,
      { owner: id.owner, repo: id.repo },
      id.number,
    )
    return {
      externalId,
      url: detail.url || githubIssuesLogic.githubIssueUrl(id),
      title: detail.title,
      // GitHub issues have no workflow status or type beyond open/closed; surface
      // the state as the status and a constant type so the structured prompt
      // rendering stays uniform across sources.
      status: detail.state,
      type: 'Issue',
      assignee: detail.assignee,
      priority: null,
      labels: detail.labels,
      description: detail.body,
      comments: detail.comments,
    }
  }

  /**
   * Search issues visible to *this workspace's* GitHub App installation. The
   * installation token only sees its own account's repos, so scoping to the
   * workspace's installation keeps results from leaking across tenants — a
   * deployment may host many installations, but a workspace owns exactly one.
   * Credentials are unused (the App authenticates), matching `fetchTask`.
   */
  async search(
    _credentials: TaskCredentials,
    query: string,
    workspaceId: string,
  ): Promise<TaskSearchResult[]> {
    const installation = await this.deps.installations.getByWorkspace(workspaceId)
    if (!installation) return []
    const hits = await this.deps.githubClient
      .searchIssues(installation.installationId, query, 20)
      .catch(() => [])
    const out: TaskSearchResult[] = []
    const seen = new Set<string>()
    for (const hit of hits) {
      const externalId = githubIssuesLogic.githubIssueExternalId(hit)
      if (seen.has(externalId)) continue
      seen.add(externalId)
      out.push({
        source: 'github',
        externalId,
        title: hit.title,
        url: hit.url,
        status: hit.state,
        excerpt: '',
      })
    }
    return out.slice(0, 20)
  }

  /**
   * Find the GitHub App installation whose account owns `owner`. The
   * installation token for that account is what can read the repo's issues,
   * regardless of which workspace triggered the import (one account → one
   * installation, shared across that account's workspaces).
   */
  private async resolveInstallationId(owner: string): Promise<number> {
    const active = await this.deps.installations.listActive()
    const match = active.find((i) => i.accountLogin.toLowerCase() === owner.toLowerCase())
    if (!match) {
      throw new ConflictError(
        `No GitHub App installation found for "${owner}". Install the GitHub App on that account to link its issues.`,
      )
    }
    return match.installationId
  }
}
