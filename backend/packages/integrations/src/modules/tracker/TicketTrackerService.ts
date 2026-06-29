import type {
  CreateTicketRequest,
  CreatedTicket,
  TicketTrackerProvider,
  TrackerSettingsRepository,
} from '@cat-factory/kernel'
import { buildJiraIssuePayload } from './jira.create.logic.js'
import {
  LINEAR_ISSUE_CREATE_MUTATION,
  buildLinearIssueCreateVariables,
  parseLinearIssueCreateResponse,
} from './linear.create.logic.js'
import { linearAuthFromCredentials, postLinearGraphql } from '../shared/linear.client.js'
import { toBase64 } from './base64.js'

// TicketTrackerService: the runtime-neutral `TicketTrackerProvider` the tech-debt
// pipeline's `tracker` step uses to file a ticket. It resolves the workspace's
// tracker selection and dispatches to GitHub Issues or Jira. Credential sourcing
// and GitHub auth differ per runtime, so they are injected: the Cloudflare facade
// files GitHub issues through its GitHub App client + repo projection and reads Jira
// credentials from the workspace's `task_connections`; the Node facade files via a
// token + env-configured repo and reads Jira credentials from env. The Jira HTTP +
// markdown→ADF logic stays here (it is identical across runtimes). Any resolver left
// unset makes that tracker pass through (returns null).

/** Jira Cloud credentials (HTTP Basic: account email + API token against a site). */
export interface JiraConnection {
  baseUrl: string
  accountEmail: string
  apiToken: string
}

/** Linear credentials: an OAuth access token (preferred) or a personal API key. */
export interface LinearConnection {
  apiKey?: string
  token?: string
}

export interface TicketTrackerServiceDependencies {
  trackerSettingsRepository: TrackerSettingsRepository
  /**
   * Files a GitHub issue for the request's service frame and returns the created
   * ticket, or null when GitHub isn't configured for the workspace. The facade
   * resolves the repo + auth (App installation token on Cloudflare, a token + env
   * repo on Node). Absent → the GitHub tracker passes through.
   */
  fileGitHubIssue?: (request: CreateTicketRequest) => Promise<CreatedTicket | null>
  /**
   * Resolves the workspace's Jira credentials, or null when Jira isn't configured.
   * Absent → the Jira tracker passes through.
   */
  resolveJiraConnection?: (workspaceId: string) => Promise<JiraConnection | null>
  /**
   * Resolves the workspace's Linear credentials, or null when Linear isn't
   * configured. Absent → the Linear tracker passes through.
   */
  resolveLinearConnection?: (workspaceId: string) => Promise<LinearConnection | null>
  /**
   * HTTP transport for the Jira/Linear create call. Injected by each runtime (both
   * expose a global `fetch`) so this package needs no DOM lib; absent → those
   * trackers pass through.
   */
  fetchImpl?: FetchLike
}

/**
 * The minimal slice of the Fetch API the Jira calls need (no DOM lib). `body` is
 * optional and must be omitted for GET/HEAD: the real `fetch` (undici + workerd)
 * throws `TypeError: Request with GET/HEAD method cannot have body` for ANY non-null
 * body, including an empty string.
 */
export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
) => Promise<{ ok: boolean; status: number; text(): Promise<string>; json(): Promise<unknown> }>

const USER_AGENT = 'cat-factory'

export class TicketTrackerService implements TicketTrackerProvider {
  constructor(private readonly deps: TicketTrackerServiceDependencies) {}

  async createTicket(request: CreateTicketRequest): Promise<CreatedTicket | null> {
    const settings = await this.deps.trackerSettingsRepository.get(request.workspaceId)
    if (!settings?.tracker) return null
    if (settings.tracker === 'github') return (await this.deps.fileGitHubIssue?.(request)) ?? null
    if (settings.tracker === 'jira') return this.createJiraIssue(request, settings.jiraProjectKey)
    if (settings.tracker === 'linear') return this.createLinearIssue(request, settings.linearTeamId)
    return null
  }

  private async createLinearIssue(
    request: CreateTicketRequest,
    teamId: string | null,
  ): Promise<CreatedTicket | null> {
    const { resolveLinearConnection, fetchImpl } = this.deps
    if (!resolveLinearConnection || !fetchImpl || !teamId) return null
    const connection = await resolveLinearConnection(request.workspaceId)
    if (!connection?.token && !connection?.apiKey) return null

    const data = await postLinearGraphql<unknown>(
      fetchImpl,
      linearAuthFromCredentials(connection),
      LINEAR_ISSUE_CREATE_MUTATION,
      buildLinearIssueCreateVariables({
        teamId,
        title: request.title,
        body: request.body,
      }),
    )
    return parseLinearIssueCreateResponse(data)
  }

  private async createJiraIssue(
    request: CreateTicketRequest,
    projectKey: string | null,
  ): Promise<CreatedTicket | null> {
    const { resolveJiraConnection, fetchImpl } = this.deps
    if (!resolveJiraConnection || !fetchImpl || !projectKey) return null
    const connection = await resolveJiraConnection(request.workspaceId)
    if (!connection) return null
    const { baseUrl, accountEmail, apiToken } = connection
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
