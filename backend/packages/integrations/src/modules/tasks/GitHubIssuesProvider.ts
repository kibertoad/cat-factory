import {
  ConflictError,
  ValidationError,
  type BugCandidate,
  type GitHubClient,
  type GitHubInstallation,
  type GitHubInstallationRepository,
  type GitHubIssueSearchHit,
  type IssueIntakeQuery,
  type TaskContent,
  type TaskCredentials,
  type TaskSearchRepoScope,
  type TaskSearchResult,
  type TaskSourceDiagnostic,
  type TaskSourceProvider,
  type TrackerBoard,
  type NormalizedTaskConnection,
} from '@cat-factory/kernel'
import type { TaskSourceReadReason } from '@cat-factory/contracts'
import { GITHUB_ISSUES_DESCRIPTOR } from './github-issues.logic.js'
import * as githubIssuesLogic from './github-issues.logic.js'
import { httpStatusOf } from './tasks.logic.js'
import { githubIssuesWebhookAdapter } from './webhook/adapters.js'

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

/** Bounded page walk for issue-intake overscan, so a run of already-worked issues at the
 * front of the oldest-first results can't starve the pickup while eligible ones exist. */
const INTAKE_MAX_PAGES = 5

export class GitHubIssuesProvider implements TaskSourceProvider {
  readonly kind = 'github' as const
  /**
   * Inbound webhook capability (verify + parse), so a github delivery can drive intake and
   * ticket replies without waiting for the next polling sweep. See
   * `backend/docs/adr/0032-tracker-webhook-intake.md`.
   */
  readonly webhook = githubIssuesWebhookAdapter
  readonly descriptor = GITHUB_ISSUES_DESCRIPTOR
  /**
   * Repo-backed: an `owner/repo#number` id names its repository, so this source's search
   * requires a scope and its imported rows narrow to one. See the kernel port.
   */
  readonly repoScope = { matches: githubIssuesLogic.githubIssueInRepoScope }

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
    const ref = { owner: id.owner, repo: id.repo }
    const detail = await this.deps.githubClient.getIssue(installationId, ref, id.number)
    // Sub-issues (the GitHub-native parent→child relationship) are the epic-import's
    // children. Best-effort: a client/runtime without the sub-issues API, or an issue
    // with none, yields no children — the issue then imports as a flat task.
    let childExternalIds: string[] = []
    if (this.deps.githubClient.listSubIssues) {
      const subs = await this.deps.githubClient
        .listSubIssues(installationId, ref, id.number)
        .catch(() => [])
      childExternalIds = subs.map((s) =>
        githubIssuesLogic.githubIssueExternalId({ owner: s.owner, repo: s.repo, number: s.number }),
      )
    }
    // GitHub has no dependency field, so "blocked by"/"depends on" are parsed from the body.
    const links = githubIssuesLogic.parseIssueDependencyLinks(detail.body, id.owner, id.repo)
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
      isEpic: childExternalIds.length > 0,
      parentExternalId: detail.parentRef ?? null,
      childExternalIds,
      links,
    }
  }

  /**
   * Search issues in ONE repository: the one linked to the service frame the search runs
   * from. `scope` is therefore REQUIRED, and a `null` one is refused rather than widened —
   * GitHub's `/search/issues` carries no scope of its own, so an unscoped query returns
   * whatever the credential can reach, which for a PAT-backed deployment is every public
   * repository on GitHub. The port makes the ARGUMENT mandatory so a caller cannot reach
   * this by forgetting it; the throw below is what answers a caller that passed the
   * repo-less `null` a Jira search legitimately passes. Credentials are unused (the App/PAT
   * authenticates out-of-band), matching `fetchTask`.
   *
   * Within the scope, input that names one specific issue — a pasted issue URL, the
   * `owner/repo#n` shorthand, or a bare issue number — is resolved to that exact issue and
   * surfaced FIRST rather than fuzzy-matched. A reference naming ANOTHER repository is not
   * resolved here at all (see `detectExactGitHubIssueRef`): it stays linkable as an explicit
   * reference through the import path, but it is never dressed up as a search hit. A miss on
   * the exact lookup (e.g. a number with no such issue) falls through to the text search
   * instead of failing.
   */
  async search(
    _credentials: TaskCredentials,
    query: string,
    workspaceId: string,
    scope: TaskSearchRepoScope | null,
  ): Promise<TaskSearchResult[]> {
    if (!scope) {
      throw new ValidationError(
        'A GitHub issue search must be scoped to a repository. Run it from a service frame ' +
          'linked to a repo, or paste the issue URL to link one directly.',
        { reason: 'repo_scope_required' satisfies TaskSourceReadReason },
      )
    }
    const installation = await this.deps.installations.getByWorkspace(workspaceId)
    if (!installation) return []
    const out: TaskSearchResult[] = []
    const seen = new Set<string>()

    // Exact match first: a pasted URL/shorthand or a bare number resolves to one
    // issue, which the picker offers as the top option ("point at it, don't search").
    const exactId = githubIssuesLogic.detectExactGitHubIssueRef(query, scope)
    if (exactId) {
      const hit = await this.fetchExact(exactId, installation).catch(() => null)
      if (hit) {
        seen.add(exactId)
        out.push(hit)
      }
    }

    const hits = await this.deps.githubClient
      .searchIssues(
        installation.installationId,
        githubIssuesLogic.buildGitHubIssueSearchQuery(query, scope),
        20,
      )
      .catch(() => [])
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
   * Issue-intake predicate search: one repo-scoped search-API call with every
   * expressible predicate compiled into the query text (open-only, labels, type,
   * title fragment — see {@link githubIssuesLogic.buildGitHubIntakeQuery}),
   * ordered oldest-first via the API's `created-asc` sort. The already-worked
   * exclusion list is the one predicate GitHub search can't express, so the call
   * overscans by the exclusion count (bounded by the API's 100/page) and filters
   * the excluded ids from the single response — never a per-candidate lookup.
   */
  async searchIssues(
    _credentials: TaskCredentials,
    query: IssueIntakeQuery,
    workspaceId: string,
  ): Promise<TaskSearchResult[]> {
    const hits = await this.walkIntakeHits(query, workspaceId)
    return hits.map((hit) => ({
      source: 'github',
      externalId: githubIssuesLogic.githubIssueExternalId(hit),
      title: hit.title,
      url: hit.url,
      status: hit.state,
      excerpt: '',
    }))
  }

  /**
   * The oldest-first page walk BOTH intake reads ride, returning the eligible hits so each
   * caller only supplies its own projection ({@link TaskSearchResult} for the recurring
   * intake, {@link BugCandidate} for a hunt).
   *
   * Shared rather than copied because every rule in here is one the two must agree on, and a
   * second copy is how they stop agreeing — the unassigned guard below landed in one of them
   * only. The walk: compile the predicates into one search text, overscan by the exclusion
   * count (the one predicate GitHub search can't express, and the excluded issues ARE the
   * oldest so they cluster at the front), and page through — bounded — so a first page that is
   * entirely excluded can't starve the result while eligible issues exist beyond it.
   */
  private async walkIntakeHits(
    query: IssueIntakeQuery,
    workspaceId: string,
  ): Promise<GitHubIssueSearchHit[]> {
    const installation = await this.deps.installations.getByWorkspace(workspaceId)
    if (!installation) return []
    // Owner/repo are case-insensitive on GitHub, so normalize both sides — otherwise an
    // already-worked issue stored with different casing than the API's canonical form
    // slips past the filter and is re-picked.
    const excluded = new Set((query.excludeExternalIds ?? []).map((id) => id.toLowerCase()))
    const searchText = githubIssuesLogic.buildGitHubIntakeQuery(query)
    const per = Math.min(query.limit + excluded.size, 100)
    const out: GitHubIssueSearchHit[] = []
    for (let page = 1; page <= INTAKE_MAX_PAGES && out.length < query.limit; page++) {
      const hits = await this.deps.githubClient.searchIssues(
        installation.installationId,
        searchText,
        per,
        'created-asc',
        page,
      )
      for (const hit of hits) {
        const externalId = githubIssuesLogic.githubIssueExternalId(hit)
        if (excluded.has(externalId.toLowerCase())) continue
        // Defence in depth on the unassigned predicate: `no:assignee` is what actually
        // narrows the search, but an adapter that reports an assignee while ignoring the
        // qualifier would otherwise offer up somebody else's in-flight work as free to take.
        if (query.unassignedOnly && hit.assignee) continue
        out.push(hit)
        if (out.length >= query.limit) break
      }
      if (hits.length < per) break // a short page is the last page — stop paging
    }
    return out
  }

  /**
   * List the workspace installation's repositories as hunt boards. No installation ⇒ an empty
   * list, matching every other read on this provider (GitHub Issues rides the App, so "not
   * installed" is an absence, not an error).
   */
  async listBoards(_credentials: TaskCredentials, workspaceId: string): Promise<TrackerBoard[]> {
    const installation = await this.deps.installations.getByWorkspace(workspaceId)
    if (!installation) return []
    const page = await this.deps.githubClient.listInstallationRepos(installation.installationId)
    return githubIssuesLogic.githubReposToBoards(page.items)
  }

  /**
   * Bug-hunt candidate search: the SAME repo-scoped walk as {@link searchIssues} (now also
   * carrying `no:assignee`, from `query.unassignedOnly`), projected onto the richer candidate
   * shape. GitHub's search response already carries the body, labels, age and comment count,
   * so no per-candidate detail fetch is needed — the whole board scan is one request per page.
   */
  async listBugCandidates(
    _credentials: TaskCredentials,
    query: IssueIntakeQuery,
    workspaceId: string,
  ): Promise<BugCandidate[]> {
    const hits = await this.walkIntakeHits(query, workspaceId)
    return hits.map(githubIssuesLogic.githubHitToBugCandidate)
  }

  /**
   * Fetch one issue by its canonical external id and project it as a lean search hit,
   * constrained to the SEARCHING workspace's own installation. A pasted issue URL can
   * name any `owner/repo`, but the search must never reach across tenants to a different
   * account's installation to read its issues — that would leak the title/url/state of a
   * repo this workspace has no relationship to (see `search`'s isolation note). An exact
   * ref outside this installation's account returns null and falls through to the
   * repo-scoped text search (which finds nothing in the wrong repo), exactly as a miss.
   */
  private async fetchExact(
    externalId: string,
    installation: GitHubInstallation,
  ): Promise<TaskSearchResult | null> {
    const id = githubIssuesLogic.parseGitHubIssueExternalId(externalId)
    if (!id) return null
    if (id.owner.toLowerCase() !== installation.accountLogin.toLowerCase()) return null
    const detail = await this.deps.githubClient.getIssue(
      installation.installationId,
      { owner: id.owner, repo: id.repo },
      id.number,
    )
    return {
      source: 'github',
      externalId,
      title: detail.title,
      url: detail.url || githubIssuesLogic.githubIssueUrl(id),
      status: detail.state,
      excerpt: '',
    }
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
