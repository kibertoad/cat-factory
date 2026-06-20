import {
  ValidationError,
  atlassianLogic,
  type TaskComment,
  type TaskContent,
  type TaskCredentials,
  type TaskSourceProvider,
  type NormalizedTaskConnection,
} from '@cat-factory/kernel'
import { JIRA_DESCRIPTOR, jiraLogic } from '@cat-factory/integrations'

// JiraProvider for the Node facade — a faithful copy of the Cloudflare facade's
// provider (`runtimes/cloudflare/src/infrastructure/tasks/JiraProvider.ts`). Both
// are thin `fetch` shells around the shared Jira *pure* logic in
// `@cat-factory/integrations` (ref parsing, ADF→Markdown); only the HTTP shell is
// runtime-bound. Node exposes the same global `fetch` + `btoa`, so the two stay
// behaviourally identical (see CLAUDE.md "Keep the runtimes symmetric").

const USER_AGENT = 'cat-factory'

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
}
