import { type Clock, type GitHubRepo, type Paged, describeVcsApiError } from '@cat-factory/kernel'
import { githubProjection as gp } from '@cat-factory/integrations'
import {
  ACCEPT,
  API_VERSION,
  GitHubApiError,
  MAX_PAGES,
  PER_PAGE,
  USER_AGENT,
  numHeader,
  parseLastPage,
  parseNextLink,
} from './githubHttpHelpers.js'

// Repo reads authenticated with a CALLER-SUPPLIED personal access token rather than the App
// registry — the personal-PAT repo access feature (`docs/initiatives/personal-pat-repo-access.md`):
// the picker expands with the repos a viewer's own token can reach, and linking one creates a
// personal service.
//
// A distinct concern from the rest of `FetchGitHubClient`, which authenticates as an installation
// and accounts for rate limits per installation: nothing here mints, caches or records anything.
// Extracted along the same seam as `reviewPosting.ts` / `branchProtection.ts`, since the client is
// at its size budget; it keeps thin delegates.

/** What the token-authenticated reads need off the client: the API base and the clock. */
export interface ViewerTokenDeps {
  apiBase: string
  clock: Clock
}

export async function listReposForToken(
  deps: ViewerTokenDeps,
  token: string,
): Promise<Paged<GitHubRepo>> {
  // The PAT analogue of `/installation/repositories` (App-only): enumerate the repos the
  // token can reach. Flagged `linkedVia:'user_pat'` — personal, not App-reachable. The
  // installation id is a placeholder here (the picker dedups by github id); the link flow
  // attributes the row to the workspace's real installation.
  const syncedAt = deps.clock.now()
  const base = `/user/repos?per_page=${PER_PAGE}&sort=full_name&affiliation=owner,collaborator,organization_member`
  const map = (json: unknown): GitHubRepo[] =>
    ((json as gp.GhRepoPayload[] | null) ?? []).map((r) => ({
      ...gp.toRepoProjection(r, 0, syncedAt),
      linkedVia: 'user_pat' as const,
    }))

  // Page 1 first: its `Link: rel="last"` header reveals how many pages the token spans, so the
  // rest fetch CONCURRENTLY rather than walking `next` one blocking request at a time. A broad
  // PAT (hundreds–thousands of repos) thus costs ~2 round-trips instead of ~MAX_PAGES serial
  // ones — the difference between a snappy picker and a ~17s stall.
  const first = await requestWithToken(deps, base, token)
  const items: GitHubRepo[] = map(first.json)

  if (first.last && first.last > 1) {
    const lastPage = Math.min(first.last, MAX_PAGES)
    const rest = await Promise.all(
      Array.from({ length: lastPage - 1 }, (_, i) =>
        requestWithToken(deps, `${base}&page=${i + 2}`, token),
      ),
    )
    for (const r of rest) items.push(...map(r.json))
    // A `last` beyond our page cap means the token reaches more repos than we enumerated.
    return { items, truncated: first.last > MAX_PAGES }
  }

  // No `last` advertised (rare for offset pagination): fall back to the serial `next` walk so
  // completeness is never traded for the speed-up. A `next` still present at the page cap means
  // the token reaches more than we enumerated — flag it so the access-cache refresh records
  // additively rather than replacing (a truncated REPLACE would drop reachable repos and
  // fail-closed-redact the user's own frames).
  let url = first.next
  for (let page = 1; url && page < MAX_PAGES; page++) {
    const { json, next } = await requestWithToken(deps, url, token)
    items.push(...map(json))
    url = next
  }
  return { items, truncated: Boolean(url) }
}

export async function getRepoForToken(
  deps: ViewerTokenDeps,
  token: string,
  repoGithubId: number,
): Promise<GitHubRepo | null> {
  try {
    const { json } = await requestWithToken(deps, `/repositories/${repoGithubId}`, token)
    return {
      ...gp.toRepoProjection(json as gp.GhRepoPayload, 0, deps.clock.now()),
      linkedVia: 'user_pat',
    }
  } catch (err) {
    if (err instanceof GitHubApiError && (err.status === 404 || err.status === 403)) return null
    throw err
  }
}

/**
 * A minimal authenticated GET using an explicit personal access token instead of the
 * installation/App registry — the only place this codebase talks to GitHub with a
 * caller-supplied bearer. Used by the PAT-scoped repo reads above; never mints or caches.
 */
async function requestWithToken(
  deps: ViewerTokenDeps,
  pathOrUrl: string,
  token: string,
): Promise<{ json: unknown; next?: string; last?: number }> {
  const url = pathOrUrl.startsWith('http') ? pathOrUrl : `${deps.apiBase}${pathOrUrl}`
  const res = await fetch(url, {
    headers: {
      authorization: `Bearer ${token}`,
      accept: ACCEPT,
      'user-agent': USER_AGENT,
      'x-github-api-version': API_VERSION,
    },
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    const resetSec = numHeader(res, 'x-ratelimit-reset')
    const rateLimited = numHeader(res, 'x-ratelimit-remaining') === 0
    throw new GitHubApiError(
      res.status,
      describeVcsApiError({
        provider: 'github',
        status: res.status,
        method: 'GET',
        url,
        body: text.slice(0, 300),
        rateLimited,
        resetAt: resetSec === null ? null : resetSec * 1000,
      }),
      rateLimited,
    )
  }
  const json = res.status === 204 ? null : await res.json().catch(() => null)
  const link = res.headers.get('link')
  return { json, next: parseNextLink(link), last: parseLastPage(link) }
}
