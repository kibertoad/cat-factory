import {
  ConflictError,
  UnavailableError,
  ValidationError,
  type BugCandidate,
  type GitHubClient,
  type GitHubInstallation,
  type GitHubIssueSearchHit,
  type GitHubInstallationRepository,
  type IssueIntakeQuery,
  type NormalizedTaskConnection,
  type TaskContent,
  type TaskCredentials,
  type TaskSearchRepoScope,
  type TaskSearchResult,
  type TaskSourceDiagnostic,
  type TaskSourceProvider,
  type TrackerBoard,
} from '@cat-factory/kernel'
import type { TaskSourceReadReason } from '@cat-factory/contracts'
import { GITLAB_ISSUES_DESCRIPTOR } from './gitlab-issues.logic.js'
import * as gitlabIssuesLogic from './gitlab-issues.logic.js'
import { httpStatusOf } from './tasks.logic.js'

// GitLabIssuesProvider: the task-source provider for GitLab issues, the sibling of
// GitHubIssuesProvider and built on the same credentialless shape — it stores no
// credentials of its own and reads through the workspace's existing VCS connection
// (the `provider: 'gitlab'` row in `github_installations`, carrying the sealed PAT).
// GitLab issue descriptions are already Markdown, so no body conversion is needed.
//
// Runtime-neutral by construction: it depends only on kernel ports (GitHubClient,
// GitHubInstallationRepository) and the shared pure logic, so both facades wire the
// SAME class (CLAUDE.md "Keep the runtimes symmetric").
//
// Two differences from the GitHub provider are load-bearing rather than incidental:
//
//  1. **Every read is scoped to the SEARCHING workspace's own connection.** GitHub Issues
//     can resolve an installation from an issue's `owner` alone, because a GitHub App
//     installation is keyed on the account that owns the repo. A GitLab PAT connection is
//     keyed on the workspace, and its account login is the token's USER, which has no
//     relation to the group a project lives under — so there is nothing to match on, and a
//     scan across connections would be a cross-tenant read rather than a resolution.
//  2. **Search is a project-scoped REQUEST, not a scoped query string.** GitLab's global
//     issue search takes no project qualifier, so the scope rides `searchProjectIssues`
//     (kernel port) as an argument. See that port for why the difference matters.
export interface GitLabIssuesProviderDependencies {
  /**
   * The GitLab-backed client (a `FetchGitLabClient` presented as a `GitHubClient` by
   * `vcsBackedGitHubClient`), whose token source decrypts the workspace's sealed PAT.
   * NEVER the provider-routing client: this source reads GitLab connections only, and a
   * router would hand it a GitHub App connection to answer GitLab questions about.
   */
  gitlabClient: GitHubClient
  /** Resolves the workspace's VCS connection (the row carrying `provider: 'gitlab'`). */
  installations: GitHubInstallationRepository
  /**
   * The deployment's GitLab WEB base (`https://gitlab.example.com`), used ONLY to rebuild an
   * issue URL the API answered without. Absent ⇒ such an issue carries no URL, which renders
   * as no link; a constant `gitlab.com` would instead render a link into a stranger's
   * instance (see `gitlabIssueUrl`).
   */
  webBaseUrl?: string
}

/**
 * Bounded page walk for intake/hunt overscan, so a run of already-worked issues at the front of
 * the oldest-first results cannot starve the pickup while eligible ones exist beyond it. Same
 * bound as the GitHub provider's, for the same reason.
 */
const INTAKE_MAX_PAGES = 5

/** GitLab's own ceiling on `per_page`, which is what bounds one overscan request. */
const GITLAB_MAX_PER_PAGE = 100

export class GitLabIssuesProvider implements TaskSourceProvider {
  readonly kind = 'gitlab' as const
  readonly descriptor = GITLAB_ISSUES_DESCRIPTOR
  /**
   * Repo-backed: a `group/sub/project#iid` id names its project, so this source's search
   * requires a scope and its imported rows narrow to one. See the kernel port.
   */
  readonly repoScope = { matches: gitlabIssuesLogic.gitlabIssueInRepoScope }

  constructor(private readonly deps: GitLabIssuesProviderDependencies) {}

  /**
   * GitLab issues ride the workspace's VCS connection, so there is nothing to validate or
   * persist — the connection is a marker. Any supplied fields are ignored (the connect form
   * has none).
   */
  normalizeConnection(_input: TaskCredentials): NormalizedTaskConnection {
    return { credentials: {}, label: 'GitLab' }
  }

  parseRef(input: string): string | null {
    return gitlabIssuesLogic.parseGitLabIssueRef(input)
  }

  /**
   * Fetch one issue as structured content. `iid` (the project-relative number the external
   * id carries) is what the API path takes; the URL comes from the issue's own `web_url`,
   * falling back to one rebuilt from the deployment's web base — never a `gitlab.com`
   * constant, which would be wrong for every self-managed instance.
   *
   * Two fields are STATED as empty rather than guessed, because GitLab's basic issue API
   * has no equivalent to read them from:
   *  - `childExternalIds`: GitLab has no parent→child issue relation (the same accepted gap
   *    `listSubIssues` is on the client), so every GitLab issue imports FLAT.
   *  - `links`: GitLab models dependencies as native issue LINKS, not as body prose. Running
   *    the GitHub body-scan grammar over a GitLab body would mint ids against a project-path
   *    shape it cannot express, i.e. plausible-looking edges to issues that do not exist.
   */
  async fetchTask(
    _credentials: TaskCredentials,
    externalId: string,
    workspaceId: string,
  ): Promise<TaskContent> {
    const id = gitlabIssuesLogic.parseGitLabIssueExternalId(externalId)
    if (!id) {
      throw new ValidationError(`"${externalId}" is not a valid GitLab issue reference`)
    }
    const connection = await this.requireConnection(workspaceId)
    const detail = await this.deps.gitlabClient.getIssue(
      connection.installationId,
      { owner: id.owner, repo: id.repo },
      id.number,
    )
    return {
      externalId,
      url: detail.url || gitlabIssuesLogic.gitlabIssueUrl(id, this.deps.webBaseUrl),
      title: detail.title,
      // GitLab issues have no workflow status beyond opened/closed and no type field on the
      // basic API; surface the state as the status and a constant type so the structured
      // prompt rendering stays uniform across sources.
      status: detail.state,
      type: 'Issue',
      assignee: detail.assignee,
      priority: null,
      labels: detail.labels,
      description: detail.body,
      comments: detail.comments,
      isEpic: false,
      parentExternalId: null,
      childExternalIds: [],
    }
  }

  /**
   * Search issues in ONE project: the one linked to the service frame the search runs from.
   * `scope` is therefore REQUIRED, and a `null` one is refused rather than widened, for a
   * reason that is sharper on GitLab than on GitHub: GitLab's `/search?scope=issues` accepts
   * no project qualifier at all, so an unscoped search cannot be narrowed after the fact and
   * returns every issue the PAT can read across the whole instance. The scoped read used
   * here (`searchProjectIssues`) takes the project as an argument, so there is no unscoped
   * spelling of it to reach by accident.
   *
   * Input that names one specific issue — a pasted URL, the `group/project#n` shorthand, or
   * a bare number — resolves to that exact issue and is surfaced FIRST. A reference naming
   * ANOTHER project is not resolved here at all (it stays linkable through the explicit
   * attach-by-reference path, but is never dressed up as a search hit), and a miss on the
   * exact lookup falls through to the text search rather than failing.
   */
  async search(
    _credentials: TaskCredentials,
    query: string,
    workspaceId: string,
    scope: TaskSearchRepoScope | null,
  ): Promise<TaskSearchResult[]> {
    if (!scope) {
      throw new ValidationError(
        'A GitLab issue search must be scoped to a project. Run it from a service frame ' +
          'linked to a repo, or paste the issue URL to link one directly.',
        { reason: 'repo_scope_required' satisfies TaskSourceReadReason },
      )
    }
    const connection = await this.deps.installations.getByWorkspace(workspaceId)
    if (!connection || connection.provider !== 'gitlab') return []
    const searchProject = this.deps.gitlabClient.searchProjectIssues
    if (!searchProject) return []
    const out: TaskSearchResult[] = []
    const seen = new Set<string>()

    // Exact match first: a pasted URL/shorthand or a bare number resolves to one issue,
    // which the picker offers as the top option ("point at it, don't search").
    const exactId = gitlabIssuesLogic.detectExactGitLabIssueRef(query, scope)
    if (exactId) {
      const hit = await this.fetchExact(exactId, connection).catch(() => null)
      if (hit) {
        seen.add(exactId)
        out.push(hit)
      }
    }

    const hits = await searchProject
      .call(
        this.deps.gitlabClient,
        connection.installationId,
        { owner: scope.owner, repo: scope.repo },
        gitlabIssuesLogic.buildGitLabIssueSearchQuery(query, 20),
      )
      .catch(() => [])
    for (const hit of hits) {
      const externalId = gitlabIssuesLogic.gitlabIssueExternalId(hit)
      if (seen.has(externalId)) continue
      seen.add(externalId)
      out.push({
        source: 'gitlab',
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
   * Issue-intake predicate search: the oldest open issue(s) on the schedule's configured
   * project matching every predicate, as lean hits the intake step imports straight away.
   */
  async searchIssues(
    _credentials: TaskCredentials,
    query: IssueIntakeQuery,
    workspaceId: string,
  ): Promise<TaskSearchResult[]> {
    const hits = await this.walkIntakeHits(query, workspaceId)
    return hits.map((hit) => ({
      source: 'gitlab',
      externalId: gitlabIssuesLogic.gitlabIssueExternalId(hit),
      title: hit.title,
      url: hit.url,
      status: hit.state,
      excerpt: '',
    }))
  }

  /**
   * List the projects the workspace's GitLab connection can reach, as hunt boards. No GitLab
   * connection ⇒ an empty list, matching every other read on this provider (the connection
   * authenticates out of band, so "not connected" is an absence rather than an error).
   */
  async listBoards(_credentials: TaskCredentials, workspaceId: string): Promise<TrackerBoard[]> {
    const connection = await this.deps.installations.getByWorkspace(workspaceId)
    if (!connection || connection.provider !== 'gitlab') return []
    const page = await this.deps.gitlabClient.listInstallationRepos(connection.installationId)
    return gitlabIssuesLogic.gitlabProjectsToBoards(page.items)
  }

  /**
   * Bug-hunt candidate search: the SAME walk as {@link searchIssues}, projected onto the richer
   * candidate shape the ranking model reads. GitLab's project-issues response already carries the
   * description, labels, age and note count, so the whole scan is one request per page and never
   * a per-candidate detail fetch.
   */
  async listBugCandidates(
    _credentials: TaskCredentials,
    query: IssueIntakeQuery,
    workspaceId: string,
  ): Promise<BugCandidate[]> {
    const hits = await this.walkIntakeHits(query, workspaceId)
    return hits.map(gitlabIssuesLogic.gitlabHitToBugCandidate)
  }

  /**
   * The oldest-first page walk BOTH intake reads ride, returning the eligible hits so each caller
   * supplies only its own projection. Shared rather than copied for the reason the GitHub twin
   * states: every rule in here is one the recurring intake and the hunt must agree on.
   *
   * The exclusion list is the one predicate the project-issues endpoint cannot express, and the
   * excluded issues ARE the oldest, so they cluster at the front of the ordering: the walk
   * overscans by the exclusion count and pages (bounded) rather than reporting an empty board
   * because its first page was entirely already-worked.
   *
   * Comparison is case-SENSITIVE, unlike the GitHub twin's: both sides of it are GitLab project
   * paths built from the same `path_with_namespace`, and folding case would let two projects
   * GitLab serves as distinct answer for each other.
   */
  private async walkIntakeHits(
    intake: IssueIntakeQuery,
    workspaceId: string,
  ): Promise<GitHubIssueSearchHit[]> {
    const connection = await this.deps.installations.getByWorkspace(workspaceId)
    if (!connection || connection.provider !== 'gitlab') return []
    const searchProject = this.deps.gitlabClient.searchProjectIssues
    if (!searchProject) {
      // Never an empty result: "this deployment cannot scan a GitLab board" and "this board has
      // no open bugs" are opposite facts, and only the first one names something to fix.
      // No `reason`: the status class's generic copy ("this deployment has not configured the
      // capability this action needs") is the accurate claim here, where an outage reason would
      // send an operator looking for a fault in a deployment that simply is not wired for it.
      throw new UnavailableError(
        'This deployment cannot search GitLab project issues: its GitLab client does not ' +
          'implement the project-scoped issue read.',
      )
    }
    const excluded = new Set(intake.excludeExternalIds ?? [])
    const per = Math.min(intake.limit + excluded.size, GITLAB_MAX_PER_PAGE)
    const out: GitHubIssueSearchHit[] = []
    for (let page = 1; page <= INTAKE_MAX_PAGES && out.length < intake.limit; page++) {
      const search = gitlabIssuesLogic.buildGitLabIntakeSearch(intake, { limit: per, page })
      const hits = await searchProject.call(
        this.deps.gitlabClient,
        connection.installationId,
        search.ref,
        search.query,
      )
      for (const hit of hits) {
        if (excluded.has(gitlabIssuesLogic.gitlabIssueExternalId(hit))) continue
        // Defence in depth on the unassigned predicate: `assignee_id=None` is what narrows the
        // search, but an adapter that reports an assignee while ignoring the parameter would
        // otherwise offer up somebody else's in-flight work as free to take.
        if (intake.unassignedOnly && hit.assignee) continue
        out.push(hit)
        if (out.length >= intake.limit) break
      }
      if (hits.length < per) break // a short page is the last page — stop paging
    }
    return out
  }

  /**
   * Fetch one issue by its canonical external id and project it as a lean search hit. Reads
   * through the SEARCHING workspace's own connection, which is the whole isolation story
   * here: a pasted URL can name any project, and the connection's token is what decides
   * whether it is readable, so an issue outside the workspace's own GitLab access simply
   * fails and falls through to the scoped text search.
   */
  private async fetchExact(
    externalId: string,
    connection: GitHubInstallation,
  ): Promise<TaskSearchResult | null> {
    const id = gitlabIssuesLogic.parseGitLabIssueExternalId(externalId)
    if (!id) return null
    const detail = await this.deps.gitlabClient.getIssue(
      connection.installationId,
      { owner: id.owner, repo: id.repo },
      id.number,
    )
    return {
      source: 'gitlab',
      externalId,
      title: detail.title,
      url: detail.url || gitlabIssuesLogic.gitlabIssueUrl(id, this.deps.webBaseUrl),
      status: detail.state,
      excerpt: '',
    }
  }

  /**
   * Live setup check: confirm the workspace's GitLab connection can actually read issues.
   * Two escalating probes, each isolating a distinct failure:
   *   1. `listInstallationRepos` — lists the projects the PAT can reach, which is what a
   *      revoked or expired token fails.
   *   2. `listIssues` on the first of them — the only call that needs the token's `read_api`
   *      reach into issues, so a 403 here pinpoints a token scoped to `read_repository` only.
   * Credentials are ignored (the connection authenticates out-of-band, keyed on the
   * workspace), and every failure is classified rather than thrown: the four causes a GitLab
   * setup fails on need four different fixes.
   */
  async diagnose(input: {
    workspaceId: string
    credentials: TaskCredentials | null
  }): Promise<TaskSourceDiagnostic> {
    const connection = await this.deps.installations.getByWorkspace(input.workspaceId)
    if (!connection || connection.provider !== 'gitlab') {
      return {
        source: 'gitlab',
        ok: false,
        status: 'not_installed',
        message:
          'This workspace has no GitLab connection. Connect one with a personal access token under Integrations → GitLab, then re-check.',
      }
    }

    let projectCount = 0
    let probeRef: { owner: string; repo: string } | null = null
    try {
      const repos = await this.deps.gitlabClient.listInstallationRepos(connection.installationId)
      projectCount = repos.items.length
      const first = repos.items[0]
      if (first) probeRef = { owner: first.owner, repo: first.name }
    } catch (err) {
      return this.classifyGitLabError(err, 'listing the projects the token can access')
    }

    if (probeRef) {
      try {
        await this.deps.gitlabClient.listIssues(connection.installationId, probeRef)
      } catch (err) {
        return this.classifyGitLabError(
          err,
          `reading issues on ${probeRef.owner}/${probeRef.repo}`,
          true,
        )
      }
    }

    return {
      source: 'gitlab',
      ok: true,
      status: 'ready',
      message: `Connected to GitLab as ${connection.accountLogin}.`,
      detail:
        projectCount > 0
          ? `${projectCount} project${projectCount === 1 ? '' : 's'} accessible.`
          : 'The token reaches no projects yet — grant it access to a project to link its issues.',
    }
  }

  /**
   * Map a GitLab client failure onto a setup diagnostic. 401 ⇒ the token was rejected
   * (revoked or expired); 403 ⇒ authenticated but the token's scope does not cover the call,
   * which on the issues probe is `read_api` specifically; a missing status ⇒ the host could
   * not be reached, which for a self-managed instance is as likely a wrong `GITLAB_API_BASE`
   * as an outage, so the message names both.
   */
  private classifyGitLabError(
    err: unknown,
    whileDoing: string,
    scoped = false,
  ): TaskSourceDiagnostic {
    const status = httpStatusOf(err)
    const base = { source: 'gitlab' as const, ok: false }
    if (status === 401) {
      return {
        ...base,
        status: 'auth_failed',
        message: `GitLab rejected the access token while ${whileDoing}. It has been revoked or has expired — reconnect with a fresh token, then re-check.`,
      }
    }
    if (status === 403) {
      return {
        ...base,
        status: 'forbidden',
        message: scoped
          ? 'GitLab accepted the token but refused to read issues. Reconnect with a token carrying the `read_api` scope (`read_repository` alone cannot read issues), then re-check.'
          : `GitLab denied access (403) while ${whileDoing}. The token is missing a required scope — reconnect with one carrying \`api\` or \`read_api\`, then re-check.`,
      }
    }
    if (status === null) {
      return {
        ...base,
        status: 'unreachable',
        message: `Couldn't reach GitLab while ${whileDoing}. Check the deployment's GitLab API base URL and network connectivity, then re-check.`,
      }
    }
    return {
      ...base,
      status: 'error',
      message: `GitLab returned ${status} while ${whileDoing}: ${err instanceof Error ? err.message : String(err)}`,
    }
  }

  /**
   * The workspace's own GitLab connection, or a refusal naming what is missing.
   *
   * A GitHub-App connection on the same workspace is refused rather than used: the two live
   * in one table, one row per workspace, so "connected to a VCS" and "connected to GitLab"
   * are different facts and only the second one can answer a GitLab issue read.
   */
  private async requireConnection(workspaceId: string): Promise<GitHubInstallation> {
    const connection = await this.deps.installations.getByWorkspace(workspaceId)
    if (!connection || connection.provider !== 'gitlab') {
      throw new ConflictError(
        'This workspace has no GitLab connection. Connect one with a personal access token under Integrations → GitLab to link its issues.',
      )
    }
    return connection
  }
}
