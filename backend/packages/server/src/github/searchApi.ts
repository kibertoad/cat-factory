import type { GitHubCodeSearchHit, GitHubIssueSearchHit } from '@cat-factory/kernel'
import { parseIssueHtmlUrl } from './githubHttpHelpers.js'

// GitHub's `/search/*` endpoints — the issue and code searches, plus the response shapes they
// return. Extracted from FetchGitHubClient so the client stays a thin transport and this cohesive
// concern (build one query string, map one `items[]` array) lives in one place, following the
// `reviewPosting.ts` precedent. Talks to GitHub only through the injected `request` executor, so
// it stays runtime-neutral and easy to unit-test.
//
// The issue search carries more than the picker needs on purpose: the response ALREADY includes
// each issue's body, labels, age and comment count, and the bug hunt rates candidates from exactly
// those fields. Reading them here is what lets a whole board scan cost one request instead of one
// per candidate — see `backend/docs/bug-hunt.md`.

/** The narrow slice of `FetchGitHubClient.request` these helpers need. */
export type GitHubSearchRequestFn = (
  path: string,
  opts: { installationId: number },
) => Promise<{ json: unknown }>

/** GitHub caps `per_page` at 100 on the search endpoints. */
const MAX_PER_PAGE = 100

/** The slice of a `/search/issues` item the issue search reads. */
interface GhSearchIssueItem {
  number?: number
  title?: string
  state?: string
  html_url?: string
  /** Present (and truthy) only on pull requests, which we filter out. */
  pull_request?: unknown
  // The fields the bug hunt's candidate listing rates from. Free on this response.
  body?: string
  labels?: ({ name?: string } | string)[]
  created_at?: string
  comments?: number
  assignee?: { login?: string } | null
}

/** The slice of a `/search/code` item the code search reads. */
interface GhSearchCodeItem {
  path?: string
  html_url?: string
  repository?: { name?: string; owner?: { login?: string } }
}

/** Normalise a label entry, which GitHub returns as an object but some adapters flatten to a string. */
function labelNames(labels: GhSearchIssueItem['labels']): string[] {
  return (labels ?? [])
    .map((label) => (typeof label === 'string' ? label : (label?.name ?? '')))
    .filter((name) => name.length > 0)
}

/**
 * Search issues visible to an installation. `order: 'created-asc'` sorts oldest-first (the issue
 * intake + bug-hunt pickup order) via the search API's `sort`/`order` params — the in-query `sort:`
 * syntax is a web-UI affordance the REST API doesn't honor — and `page` walks past a run of
 * already-worked issues that fills the first page.
 */
export async function searchIssues(
  request: GitHubSearchRequestFn,
  installationId: number,
  query: string,
  limit = 20,
  order?: 'created-asc',
  page = 1,
): Promise<GitHubIssueSearchHit[]> {
  const q = encodeURIComponent(`${query} is:issue`)
  const per = Math.min(Math.max(limit, 1), MAX_PER_PAGE)
  const sort = order === 'created-asc' ? '&sort=created&order=asc' : ''
  const pageParam = page > 1 ? `&page=${page}` : ''
  const { json } = await request(`/search/issues?q=${q}&per_page=${per}${sort}${pageParam}`, {
    installationId,
  })
  const items = ((json as { items?: GhSearchIssueItem[] } | null)?.items ?? []).filter(
    (i) => !i.pull_request,
  )
  const hits: GitHubIssueSearchHit[] = []
  for (const item of items) {
    const parts = parseIssueHtmlUrl(item.html_url ?? '')
    if (!parts) continue
    hits.push({
      owner: parts.owner,
      repo: parts.repo,
      number: item.number ?? parts.number,
      title: item.title ?? '(untitled)',
      state: item.state ?? '',
      url: item.html_url ?? '',
      body: item.body ?? '',
      labels: labelNames(item.labels),
      createdAt: item.created_at ?? '',
      commentCount: typeof item.comments === 'number' ? item.comments : 0,
      assignee: item.assignee?.login ?? null,
    })
  }
  return hits.slice(0, limit)
}

/**
 * Code-search files visible to an installation. `query` MUST already carry an `org:`/`user:`/`repo:`
 * scope qualifier (GitHub's code-search API rejects unscoped queries); the caller builds it.
 */
export async function searchCode(
  request: GitHubSearchRequestFn,
  installationId: number,
  query: string,
  limit = 20,
): Promise<GitHubCodeSearchHit[]> {
  const per = Math.min(Math.max(limit, 1), MAX_PER_PAGE)
  const { json } = await request(`/search/code?q=${encodeURIComponent(query)}&per_page=${per}`, {
    installationId,
  })
  const items = (json as { items?: GhSearchCodeItem[] } | null)?.items ?? []
  const hits: GitHubCodeSearchHit[] = []
  for (const item of items) {
    const owner = item.repository?.owner?.login
    const repo = item.repository?.name
    const path = item.path
    if (!owner || !repo || !path) continue
    hits.push({
      owner,
      repo,
      path,
      url: item.html_url ?? `https://github.com/${owner}/${repo}/blob/HEAD/${path}`,
    })
  }
  return hits.slice(0, limit)
}
