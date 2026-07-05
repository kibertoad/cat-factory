import {
  ValidationError,
  atlassianLogic,
  type IssueIntakeQuery,
  type TaskComment,
  type TaskContent,
  type TaskCredentials,
  type TaskSearchResult,
  type TaskSourceDiagnostic,
  type TaskSourceProvider,
  type NormalizedTaskConnection,
} from '@cat-factory/kernel'
import { JIRA_DESCRIPTOR } from './jira.logic.js'
import * as jiraLogic from './jira.logic.js'

// JiraProvider: the task-source provider for Jira Cloud. It authenticates with
// HTTP Basic (account email + API token, the same scheme as Confluence), fetches
// an issue via the REST v3 API, and maps it onto the structured TaskContent —
// converting the ADF description and comment bodies to the Markdown the generic
// excerpt/prompt logic consumes. All Jira-specific *pure* logic (ref parsing, ADF
// conversion) lives in `jira.logic` so it is unit-testable; this class is the thin
// `fetch` shell around it. No SDK — fetch + `btoa` suffice.
//
// Runtime-neutral: it depends only on the kernel ports + the shared pure logic and
// the global `fetch`/`btoa` (present on both runtimes), so the Cloudflare and the
// Node facade wire the SAME class (see CLAUDE.md "Keep the runtimes symmetric").

const USER_AGENT = 'cat-factory'

/** Max child-issue pages walked per epic (100/page) — a sanity bound on the import fan-out. */
const CHILD_PAGE_CAP = 20

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
    parent?: { key?: string } | null
    subtasks?: { key?: string }[]
    issuelinks?: unknown
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
    const fields =
      'summary,description,status,issuetype,assignee,priority,labels,comment,parent,subtasks,issuelinks'
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

    // Direct sub-tasks come back on the issue; an epic's children are a reverse relation,
    // so fetch them by JQL when the issue is an epic. Best-effort — a failed children query
    // never fails the import (the epic still lands, just without its children pre-linked).
    const isEpic = jiraLogic.isJiraEpicType(f.issuetype?.name)
    const childKeys = new Set<string>(
      (Array.isArray(f.subtasks) ? f.subtasks : [])
        .map((s) => s.key)
        .filter((k): k is string => !!k),
    )
    if (isEpic) {
      for (const k of await this.fetchChildKeys(credentials, json.key).catch(() => [])) {
        childKeys.add(k)
      }
    }

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
      isEpic,
      parentExternalId: f.parent?.key ?? null,
      childExternalIds: [...childKeys],
      links: jiraLogic.mapJiraIssueLinks(f.issuelinks),
    }
  }

  /**
   * List an epic's / parent's child issue keys via JQL (used by the epic-import walk).
   * Follows the enhanced-search `nextPageToken` cursor (bounded by {@link CHILD_PAGE_CAP})
   * so an epic with >100 children imports its full child set rather than silently the first
   * page. Any failed page returns what was gathered so far — best-effort, never fatal.
   */
  private async fetchChildKeys(credentials: TaskCredentials, key: string): Promise<string[]> {
    const base = credentials.baseUrl!.replace(/\/+$/, '')
    atlassianLogic.assertSafeAtlassianBaseUrl(base)
    const jql = encodeURIComponent(jiraLogic.buildJiraChildrenJql(key))
    const auth = btoa(`${credentials.accountEmail}:${credentials.apiToken}`)
    const keys: string[] = []
    let nextPageToken: string | undefined
    for (let page = 0; page < CHILD_PAGE_CAP; page++) {
      const cursor = nextPageToken ? `&nextPageToken=${encodeURIComponent(nextPageToken)}` : ''
      const url = `${base}/rest/api/3/search/jql?jql=${jql}&fields=summary&maxResults=100${cursor}`
      const res = await fetch(url, {
        method: 'GET',
        headers: {
          authorization: `Basic ${auth}`,
          accept: 'application/json',
          'user-agent': USER_AGENT,
        },
      })
      if (!res.ok) break
      const json = (await res.json().catch(() => null)) as {
        issues?: { key?: string }[]
        nextPageToken?: string
        isLast?: boolean
      } | null
      for (const i of json?.issues ?? []) if (i.key) keys.push(i.key)
      nextPageToken = json?.nextPageToken
      if (json?.isLast || !nextPageToken) break
    }
    return keys
  }

  /**
   * Live setup check: authenticate against `/myself` (the cheapest authenticated
   * read) with the stored email + API token. A 401 means Jira rejected the
   * credentials (wrong email/token, or a revoked token); a 403 means the account
   * is authenticated but lacks access; anything else surfaces verbatim. A thrown
   * fetch (DNS/network) ⇒ unreachable. Resolves (never rejects), per the port.
   */
  async diagnose(input: {
    workspaceId: string
    credentials: TaskCredentials | null
  }): Promise<TaskSourceDiagnostic> {
    const creds = input.credentials
    if (!creds?.baseUrl || !creds.accountEmail || !creds.apiToken) {
      return {
        source: 'jira',
        ok: false,
        status: 'not_connected',
        message: 'Jira has no stored credentials. Connect it with a site URL, email and API token.',
      }
    }
    const base = creds.baseUrl.replace(/\/+$/, '')
    try {
      atlassianLogic.assertSafeAtlassianBaseUrl(base)
    } catch (err) {
      return {
        source: 'jira',
        ok: false,
        status: 'error',
        message: err instanceof Error ? err.message : `Unsafe Jira base URL: ${base}`,
      }
    }
    const auth = btoa(`${creds.accountEmail}:${creds.apiToken}`)
    let res: Response
    try {
      res = await fetch(`${base}/rest/api/3/myself`, {
        method: 'GET',
        headers: {
          authorization: `Basic ${auth}`,
          accept: 'application/json',
          'user-agent': USER_AGENT,
        },
      })
    } catch {
      return {
        source: 'jira',
        ok: false,
        status: 'unreachable',
        message: `Couldn't reach ${base}. Check the site URL and network connectivity, then re-check.`,
      }
    }
    if (res.status === 401) {
      return {
        source: 'jira',
        ok: false,
        status: 'auth_failed',
        message:
          'Jira rejected the account email or API token (401). Re-check the email and generate a fresh API token, then reconnect.',
      }
    }
    if (res.status === 403) {
      return {
        source: 'jira',
        ok: false,
        status: 'forbidden',
        message:
          'Jira authenticated the account but denied access (403). Confirm the account can view the project, then re-check.',
      }
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      return {
        source: 'jira',
        ok: false,
        status: 'error',
        message: `Jira returned ${res.status} for /myself: ${text.slice(0, 200)}`,
      }
    }
    const me = (await res.json().catch(() => null)) as { displayName?: string } | null
    return {
      source: 'jira',
      ok: true,
      status: 'ready',
      message: `Authenticated to ${base}.`,
      detail: me?.displayName ? `Signed in as ${me.displayName}.` : null,
    }
  }

  async search(credentials: TaskCredentials, query: string): Promise<TaskSearchResult[]> {
    return this.searchByJql(credentials, jiraLogic.buildJiraSearchJql(query), 20)
  }

  /**
   * Issue-intake predicate search: every predicate (project, open-only, type,
   * labels, title fragment, the already-worked exclusion list) is compiled into
   * one JQL query ordered oldest-first, so Jira returns exactly the eligible
   * candidates — see {@link jiraLogic.buildJiraIntakeJql}.
   */
  async searchIssues(
    credentials: TaskCredentials,
    query: IssueIntakeQuery,
  ): Promise<TaskSearchResult[]> {
    return this.searchByJql(credentials, jiraLogic.buildJiraIntakeJql(query), query.limit)
  }

  /** Run a JQL search and map the hits (shared by the free-text and intake searches). */
  private async searchByJql(
    credentials: TaskCredentials,
    rawJql: string,
    limit: number,
  ): Promise<TaskSearchResult[]> {
    const base = credentials.baseUrl!.replace(/\/+$/, '')
    // Re-validate the stored base before fetching with the workspace's credentials
    // (defense-in-depth against a base that became unsafe since connect time).
    atlassianLogic.assertSafeAtlassianBaseUrl(base)
    const jql = encodeURIComponent(rawJql)
    // `/rest/api/3/search/jql` is the current enhanced-search endpoint; the legacy
    // GET `/rest/api/3/search` was removed by Atlassian (May 2025). The `issues[]`
    // response shape is unchanged, so `parseJiraSearchResults` still applies.
    const url = `${base}/rest/api/3/search/jql?jql=${jql}&fields=summary,status&maxResults=${limit}`
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
