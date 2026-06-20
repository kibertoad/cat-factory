import type {
  CreateTicketRequest,
  CreatedTicket,
  GitHubClient,
  TaskConnectionRepository,
  TicketTrackerProvider,
  TrackerSettingsRepository,
} from '@cat-factory/kernel'
import { buildJiraIssuePayload } from './jira.create.logic.js'
import { toBase64 } from './base64.js'

// TicketTrackerService: the runtime-neutral `TicketTrackerProvider` the tech-debt
// pipeline's `tracker` step uses to file a ticket. It resolves the workspace's
// tracker selection and dispatches to GitHub Issues (via the GitHubClient port,
// against the service's repo) or Jira (HTTP Basic against the workspace's stored
// Jira connection). Returns null when nothing is configured so the step passes
// through. All tracker-specific *pure* logic lives in `jira.create.logic`.

/** Where a GitHub issue should be filed, resolved from the service frame. */
export interface TrackerRepoTarget {
  installationId: number
  owner: string
  name: string
}

export interface TicketTrackerServiceDependencies {
  trackerSettingsRepository: TrackerSettingsRepository
  /** Files GitHub issues; absent → the GitHub tracker passes through. */
  githubClient?: GitHubClient
  /** Resolves the GitHub repo for a service frame; absent → GitHub passes through. */
  resolveRepoTarget?: (workspaceId: string, frameId: string) => Promise<TrackerRepoTarget | null>
  /** Reads the workspace's Jira credentials; absent → the Jira tracker passes through. */
  taskConnectionRepository?: TaskConnectionRepository
  /**
   * HTTP transport for the Jira create call. Injected by each runtime (both expose
   * a global `fetch`) so this package needs no DOM lib; absent → Jira passes through.
   */
  fetchImpl?: FetchLike
}

/** The minimal slice of the Fetch API the Jira create call needs (no DOM lib). */
export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean; status: number; text(): Promise<string>; json(): Promise<unknown> }>

const USER_AGENT = 'cat-factory'

export class TicketTrackerService implements TicketTrackerProvider {
  constructor(private readonly deps: TicketTrackerServiceDependencies) {}

  async createTicket(request: CreateTicketRequest): Promise<CreatedTicket | null> {
    const settings = await this.deps.trackerSettingsRepository.get(request.workspaceId)
    if (!settings?.tracker) return null
    if (settings.tracker === 'github') return this.createGitHubIssue(request)
    if (settings.tracker === 'jira') return this.createJiraIssue(request, settings.jiraProjectKey)
    return null
  }

  private async createGitHubIssue(request: CreateTicketRequest): Promise<CreatedTicket | null> {
    const { githubClient, resolveRepoTarget } = this.deps
    if (!githubClient || !resolveRepoTarget) return null
    const repo = await resolveRepoTarget(request.workspaceId, request.frameId)
    if (!repo) return null
    const issue = await githubClient.createIssue(
      repo.installationId,
      { owner: repo.owner, repo: repo.name },
      { title: request.title, body: request.body },
    )
    return { externalId: `${repo.owner}/${repo.name}#${issue.number}`, url: issue.url }
  }

  private async createJiraIssue(
    request: CreateTicketRequest,
    projectKey: string | null,
  ): Promise<CreatedTicket | null> {
    const { taskConnectionRepository, fetchImpl } = this.deps
    if (!taskConnectionRepository || !fetchImpl || !projectKey) return null
    const connection = await taskConnectionRepository.getByWorkspace(request.workspaceId, 'jira')
    if (!connection) return null
    const { baseUrl, accountEmail, apiToken } = connection.credentials
    if (!baseUrl || !accountEmail || !apiToken) return null

    const base = baseUrl.replace(/\/+$/, '')
    const url = `${base}/rest/api/3/issue`
    const auth = toBase64(`${accountEmail}:${apiToken}`)
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: {
        authorization: `Basic ${auth}`,
        accept: 'application/json',
        'content-type': 'application/json',
        'user-agent': USER_AGENT,
      },
      body: JSON.stringify(
        buildJiraIssuePayload({ projectKey, title: request.title, body: request.body }),
      ),
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`Jira POST ${url} → ${res.status}: ${text.slice(0, 300)}`)
    }
    const json = (await res.json().catch(() => null)) as { key?: string } | null
    if (!json?.key) throw new Error('Jira returned no issue key for the created issue')
    return { externalId: json.key, url: `${base}/browse/${json.key}` }
  }
}
