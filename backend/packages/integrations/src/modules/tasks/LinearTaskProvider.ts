import {
  ValidationError,
  type TaskContent,
  type TaskCredentials,
  type TaskSearchResult,
  type TaskSourceDiagnostic,
  type TaskSourceProvider,
  type NormalizedTaskConnection,
} from '@cat-factory/kernel'
import {
  LinearApiError,
  LinearGraphqlClient,
  linearAuthFromCredentials,
} from '../shared/linear.client.js'
import {
  LINEAR_ISSUE_CHILDREN_QUERY,
  LINEAR_ISSUE_COMMENTS_QUERY,
  LINEAR_ISSUE_QUERY,
  LINEAR_PAGE_CAP,
  LINEAR_SEARCH_ISSUES_QUERY,
  LINEAR_TASK_DESCRIPTOR,
  LINEAR_TEAMS_QUERY,
  LINEAR_VIEWER_QUERY,
  type LinearChildrenPage,
  type LinearCommentsPage,
  type LinearTeam,
  linearIssueSearchHit,
  mapLinearChildIds,
  mapLinearComments,
  mapLinearIssue,
  mapLinearSearchResults,
  mapLinearTeams,
  parseLinearRef,
} from './linear.logic.js'

// LinearTaskProvider: the task-source provider for Linear. It authenticates with a
// personal API key against Linear's single GraphQL endpoint (via the shared
// host-pinned, redirect-safe client) and maps an issue onto the structured
// {@link TaskContent} — status / assignee / priority / labels + the Markdown
// description, comments, parent/sub-issues and dependency relations. All
// Linear-specific pure logic (ref parsing, mapping, the GraphQL documents) lives in
// `linear.logic` so it is unit-testable; this class is the thin transport.
//
// Runtime-neutral: it depends only on the kernel ports + the shared client (global
// `fetch`), so the Cloudflare and Node facades compose the SAME class.

export class LinearTaskProvider implements TaskSourceProvider {
  readonly kind = 'linear' as const
  readonly descriptor = LINEAR_TASK_DESCRIPTOR

  normalizeConnection(input: TaskCredentials): NormalizedTaskConnection {
    // The OAuth connect flow writes a `{ token }` record directly (it never calls
    // this), so the manual connect form only ever supplies an API key — but accept
    // either so a token bag isn't rejected if it ever reaches here.
    const token = input.token?.trim()
    const apiKey = input.apiKey?.trim()
    if (!token && !apiKey) {
      throw new ValidationError('Linear requires a personal API key')
    }
    return {
      credentials: token ? { token } : { apiKey: apiKey! },
      label: 'Linear workspace',
    }
  }

  parseRef(input: string): string | null {
    return parseLinearRef(input)
  }

  async fetchTask(credentials: TaskCredentials, externalId: string): Promise<TaskContent> {
    const client = new LinearGraphqlClient(linearAuthFromCredentials(credentials))
    const data = await client.query<Parameters<typeof mapLinearIssue>[0]>(LINEAR_ISSUE_QUERY, {
      id: externalId,
    })
    const content = mapLinearIssue(data)
    return this.paginate(client, externalId, content, data)
  }

  async search(credentials: TaskCredentials, query: string): Promise<TaskSearchResult[]> {
    const client = new LinearGraphqlClient(linearAuthFromCredentials(credentials))
    const out: TaskSearchResult[] = []
    const seen = new Set<string>()

    // Exact match first: a pasted issue identifier / URL resolves to one issue, which
    // the picker offers as the top option ("point at it, don't search"). Best-effort —
    // a miss (no such issue) falls through to the free-text search below.
    const exactId = parseLinearRef(query)
    if (exactId) {
      const hit = await this.fetchExact(client, exactId).catch(() => null)
      if (hit) {
        seen.add(hit.externalId)
        out.push(hit)
      }
    }

    const data = await client.query<Parameters<typeof mapLinearSearchResults>[0]>(
      LINEAR_SEARCH_ISSUES_QUERY,
      { term: query },
    )
    for (const hit of mapLinearSearchResults(data)) {
      if (seen.has(hit.externalId)) continue
      seen.add(hit.externalId)
      out.push(hit)
    }
    return out
  }

  /** Fetch one issue by identifier and project it as a lean search hit (for the exact-match path). */
  private async fetchExact(
    client: LinearGraphqlClient,
    externalId: string,
  ): Promise<TaskSearchResult | null> {
    const data = await client.query<Parameters<typeof mapLinearIssue>[0]>(LINEAR_ISSUE_QUERY, {
      id: externalId,
    })
    return data.issue?.identifier ? linearIssueSearchHit(mapLinearIssue(data)) : null
  }

  /**
   * Linear's GraphQL connections (children, comments) return only the first page by
   * default, so an epic with many sub-issues or a long comment thread is silently
   * truncated. When the initial issue query reports more pages, walk the cursors to
   * gather the rest (bounded by {@link LINEAR_PAGE_CAP} per connection). Best-effort —
   * a failed page returns what was gathered so far, mirroring {@link JiraProvider}'s
   * epic-children walk.
   */
  private async paginate(
    client: LinearGraphqlClient,
    externalId: string,
    content: TaskContent,
    first: Parameters<typeof mapLinearIssue>[0],
  ): Promise<TaskContent> {
    const childExternalIds = [...(content.childExternalIds ?? [])]
    const comments = [...content.comments]

    let childPage = first.issue?.children?.pageInfo ?? null
    for (
      let page = 0;
      childPage?.hasNextPage && childPage.endCursor && page < LINEAR_PAGE_CAP;
      page++
    ) {
      const data = await client
        .query<{ issue?: { children?: LinearChildrenPage } | null }>(LINEAR_ISSUE_CHILDREN_QUERY, {
          id: externalId,
          after: childPage.endCursor,
        })
        .catch(() => null)
      if (!data) break
      const conn = data.issue?.children
      for (const id of mapLinearChildIds(conn)) childExternalIds.push(id)
      childPage = conn?.pageInfo ?? null
    }

    let commentPage = first.issue?.comments?.pageInfo ?? null
    for (
      let page = 0;
      commentPage?.hasNextPage && commentPage.endCursor && page < LINEAR_PAGE_CAP;
      page++
    ) {
      const data = await client
        .query<{ issue?: { comments?: LinearCommentsPage } | null }>(LINEAR_ISSUE_COMMENTS_QUERY, {
          id: externalId,
          after: commentPage.endCursor,
        })
        .catch(() => null)
      if (!data) break
      const conn = data.issue?.comments
      for (const c of mapLinearComments(conn)) comments.push(c)
      commentPage = conn?.pageInfo ?? null
    }

    return {
      ...content,
      comments,
      childExternalIds,
      isEpic: childExternalIds.length > 0,
      type: childExternalIds.length > 0 ? 'Epic' : content.type,
    }
  }

  /**
   * List the connection's Linear teams (id + name + key), so the ticket-filing UI can
   * offer a team picker instead of asking the user to paste a raw team UUID. Linear-
   * specific (no other task source has teams), so it is NOT on the generic
   * {@link TaskSourceProvider} port — {@link TaskConnectionService} narrows to this
   * class to reach it.
   */
  async listTeams(credentials: TaskCredentials): Promise<LinearTeam[]> {
    const client = new LinearGraphqlClient(linearAuthFromCredentials(credentials))
    const data = await client.query<Parameters<typeof mapLinearTeams>[0]>(LINEAR_TEAMS_QUERY)
    return mapLinearTeams(data)
  }

  /**
   * Live setup check: read `viewer` (the cheapest authenticated query) with the
   * stored key. A 401/403 from Linear's GraphQL surfaces as auth_failed/forbidden;
   * a thrown fetch (DNS/network) ⇒ unreachable. Resolves (never rejects), per the port.
   */
  async diagnose(input: {
    workspaceId: string
    credentials: TaskCredentials | null
  }): Promise<TaskSourceDiagnostic> {
    const credentials = input.credentials
    if (!credentials?.apiKey && !credentials?.token) {
      return {
        source: 'linear',
        ok: false,
        status: 'not_connected',
        message: 'Linear has no stored credentials. Connect it with a personal API key.',
      }
    }
    try {
      const client = new LinearGraphqlClient(linearAuthFromCredentials(credentials))
      const data = await client.query<{ viewer?: { name?: string } }>(LINEAR_VIEWER_QUERY)
      return {
        source: 'linear',
        ok: true,
        status: 'ready',
        message: 'Authenticated to Linear.',
        detail: data.viewer?.name ? `Signed in as ${data.viewer.name}.` : null,
      }
    } catch (err) {
      if (err instanceof LinearApiError) {
        if (err.status === 401) {
          return {
            source: 'linear',
            ok: false,
            status: 'auth_failed',
            message:
              'Linear rejected the API key (401). Generate a fresh personal API key and reconnect.',
          }
        }
        if (err.status === 403) {
          return {
            source: 'linear',
            ok: false,
            status: 'forbidden',
            message: 'Linear authenticated the key but denied access (403). Check its scopes.',
          }
        }
        return {
          source: 'linear',
          ok: false,
          status: 'error',
          message: err.message,
        }
      }
      return {
        source: 'linear',
        ok: false,
        status: 'unreachable',
        message: "Couldn't reach Linear. Check network connectivity, then re-check.",
      }
    }
  }
}
