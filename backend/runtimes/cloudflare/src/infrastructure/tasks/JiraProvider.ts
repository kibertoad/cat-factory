import {
  ValidationError,
  atlassianLogic,
  type TaskComment,
  type TaskContent,
  type TaskCredentials,
  type TaskSearchResult,
  type TaskSourceProvider,
  type NormalizedTaskConnection,
} from '@cat-factory/kernel'
import { JIRA_DESCRIPTOR, jiraLogic } from '@cat-factory/integrations'

// JiraProvider: the task-source provider for Jira Cloud. It authenticates with
// HTTP Basic (account email + API token, the same scheme as Confluence), fetches
// an issue via the REST v3 API, and maps it onto the structured TaskContent —
// converting the ADF description and comment bodies to the Markdown the generic
// excerpt/prompt logic consumes. All Jira-specific *pure* logic (ref parsing, ADF
// conversion) lives in `@cat-factory/integrations` so it is unit-testable; this class is
// the thin `fetch` shell around it. No SDK — fetch + `btoa` suffice.

const USER_AGENT = 'cat-factory'

/** Carries the HTTP status so callers can surface a meaningful error. */
export class JiraApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = 'JiraApiError'
  }
}

interface JiraComment {
  author?: { displayName?: string }
  created?: string
  body?: unknown
}

interface IssueResponse {
  key?: string
  fields?: {
    summary?: string
    description?: unknown
    status?: { name?: string }
    issuetype?: { name?: string }
    assignee?: { displayName?: string } | null
    priority?: { name?: string } | null
    labels?: string[]
    comment?: { comments?: JiraComment[] }
  }
}

export class JiraProvider implements TaskSourceProvider {
  readonly kind = 'jira' as const
  readonly descriptor = JIRA_DESCRIPTOR

  normalizeConnection(input: TaskCredentials): NormalizedTaskConnection {
    const baseUrlRaw = input.baseUrl?.trim()
    const accountEmail = input.accountEmail?.trim()
    const apiToken = input.apiToken?.trim()
    if (!baseUrlRaw || !accountEmail || !apiToken) {
      throw new ValidationError('Jira requires a site URL, account email and API token')
    }
    const baseUrl = atlassianLogic.normalizeAtlassianBaseUrl(baseUrlRaw)
    // Guard against SSRF: the stored base URL is later fetched with the
    // workspace's credentials, so it must be a public https host.
    atlassianLogic.assertSafeAtlassianBaseUrl(baseUrl)
    return {
      credentials: { baseUrl, accountEmail, apiToken },
      label: baseUrl,
    }
  }

  parseRef(input: string): string | null {
    return jiraLogic.parseJiraRef(input)
  }

  async fetchTask(credentials: TaskCredentials, externalId: string): Promise<TaskContent> {
    const base = credentials.baseUrl!.replace(/\/+$/, '')
    const fields = 'summary,description,status,issuetype,assignee,priority,labels,comment'
    const url = `${base}/rest/api/3/issue/${encodeURIComponent(externalId)}?fields=${fields}`
    const auth = btoa(`${credentials.accountEmail}:${credentials.apiToken}`)

    const res = await fetch(url, {
      method: 'GET',
      headers: {
        authorization: `Basic ${auth}`,
        accept: 'application/json',
        'user-agent': USER_AGENT,
      },
    })

    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new JiraApiError(res.status, `Jira GET ${url} → ${res.status}: ${text.slice(0, 300)}`)
    }

    const json = (await res.json().catch(() => null)) as IssueResponse | null
    if (!json || !json.key || !json.fields) {
      throw new JiraApiError(502, `Jira returned an unexpected body for issue ${externalId}`)
    }

    const f = json.fields
    const comments: TaskComment[] = (f.comment?.comments ?? []).map((c) => ({
      author: c.author?.displayName ?? '',
      createdAt: c.created ?? '',
      body: jiraLogic.adfToMarkdown(c.body),
    }))

    return {
      externalId: json.key,
      url: `${base}/browse/${json.key}`,
      title: f.summary ?? '(untitled)',
      status: f.status?.name ?? '',
      type: f.issuetype?.name ?? '',
      assignee: f.assignee?.displayName ?? null,
      priority: f.priority?.name ?? null,
      labels: Array.isArray(f.labels) ? f.labels : [],
      description: jiraLogic.adfToMarkdown(f.description),
      comments,
    }
  }

  async search(credentials: TaskCredentials, query: string): Promise<TaskSearchResult[]> {
    const base = credentials.baseUrl!.replace(/\/+$/, '')
    const jql = encodeURIComponent(jiraLogic.buildJiraSearchJql(query))
    const url = `${base}/rest/api/3/search?jql=${jql}&fields=summary,status&maxResults=20`
    const auth = btoa(`${credentials.accountEmail}:${credentials.apiToken}`)

    const res = await fetch(url, {
      method: 'GET',
      headers: {
        authorization: `Basic ${auth}`,
        accept: 'application/json',
        'user-agent': USER_AGENT,
      },
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new JiraApiError(
        res.status,
        `Jira search ${url} → ${res.status}: ${text.slice(0, 300)}`,
      )
    }
    const json = await res.json().catch(() => null)
    return jiraLogic.parseJiraSearchResults(json, base)
  }
}
