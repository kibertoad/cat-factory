import {
  ConflictError,
  ValidationError,
  type GitHubClient,
  type GitHubInstallationRepository,
  type TaskContent,
  type TaskCredentials,
  type TaskSearchResult,
  type TaskSourceDiagnostic,
  type TaskSourceProvider,
  type NormalizedTaskConnection,
} from '@cat-factory/kernel'
import { GITHUB_ISSUES_DESCRIPTOR } from './github-issues.logic.js'
import * as githubIssuesLogic from './github-issues.logic.js'
import { httpStatusOf } from './tasks.logic.js'

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
   * Live setup check: confirm the workspace's App installation can actually read
   * issues. Three escalating probes, each isolating a distinct failure:
   *   1. `getInstallation` — validates the App's own credentials (id + key).
   *   2. `listInstallationRepos` — mints the installation token (catches a
   *      suspended/revoked install) and yields a concrete repo to probe.
   *   3. `listIssues` on that repo — the only call that needs the **Issues**
   *      permission, so a 403 here pinpoints the most common GitHub-App
   *      misconfiguration (Issues access not granted).
   * Credentials are ignored — GitHub Issues rides the App, keyed on `workspaceId`.
   */
  async diagnose(input: {
    workspaceId: string
    credentials: TaskCredentials | null
  }): Promise<TaskSourceDiagnostic> {
    const installation = await this.deps.installations.getByWorkspace(input.workspaceId)
    if (!installation) {
      return {
        source: 'github',
        ok: false,
        status: 'not_installed',
        message:
          "This workspace's GitHub App isn't installed. Install it under Integrations → GitHub.",
      }
    }
    const id = installation.installationId

    try {
      await this.deps.githubClient.getInstallation(id)
    } catch (err) {
      return this.classifyGitHubError(err, 'validating the GitHub App credentials')
    }

    let repoCount = 0
    let probeRef: { owner: string; repo: string } | null = null
    try {
      const repos = await this.deps.githubClient.listInstallationRepos(id)
      repoCount = repos.items.length
      const first = repos.items[0]
      if (first) probeRef = { owner: first.owner, repo: first.name }
    } catch (err) {
      return this.classifyGitHubError(err, 'listing the repositories the App can access')
    }

    if (probeRef) {
      try {
        await this.deps.githubClient.listIssues(id, probeRef)
      } catch (err) {
        return this.classifyGitHubError(
          err,
          `reading issues on ${probeRef.owner}/${probeRef.repo}`,
          true,
        )
      }
    }

    return {
      source: 'github',
      ok: true,
      status: 'ready',
      message: `Connected via the GitHub App on ${installation.accountLogin}.`,
      detail:
        repoCount > 0
          ? `${repoCount} repositor${repoCount === 1 ? 'y' : 'ies'} accessible.`
          : 'No repositories are shared with the App yet — grant it access to a repo to link its issues.',
    }
  }

  /**
   * Map a GitHub client failure onto a setup diagnostic. 401 ⇒ the App key/JWT was
   * rejected; 403 ⇒ authenticated but lacking a scope (when raised by the issues
   * probe, that's the Issues permission specifically); a missing status ⇒ the host
   * couldn't be reached. `permission` tags the issues-read probe so the 403 hint
   * names the exact permission to grant.
   */
  private classifyGitHubError(
    err: unknown,
    whileDoing: string,
    permission = false,
  ): TaskSourceDiagnostic {
    const status = httpStatusOf(err)
    const base = { source: 'github' as const, ok: false }
    if (status === 401) {
      return {
        ...base,
        status: 'auth_failed',
        message: `GitHub rejected the App credentials while ${whileDoing}. Re-check the App id and private key, then reconnect the installation.`,
      }
    }
    if (status === 403) {
      return {
        ...base,
        status: 'forbidden',
        message: permission
          ? "The GitHub App is installed but lacks the Issues permission. In the App's settings grant Read access to Issues and accept the permission update on the installation, then re-check."
          : `GitHub denied access (403) while ${whileDoing}. The App is missing a required permission — review its installed permissions, then re-check.`,
      }
    }
    if (status === null) {
      return {
        ...base,
        status: 'unreachable',
        message: `Couldn't reach GitHub while ${whileDoing}. Check network/API connectivity, then re-check.`,
      }
    }
    return {
      ...base,
      status: 'error',
      message: `GitHub returned ${status} while ${whileDoing}: ${err instanceof Error ? err.message : String(err)}`,
    }
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
