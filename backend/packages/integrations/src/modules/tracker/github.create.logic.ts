import type { FetchLike } from './TicketTrackerService.js'

// Token-authenticated GitHub issue creation (POST /repos/{owner}/{repo}/issues),
// kept runtime-neutral so a facade can file an issue with a short-lived, per-tenant
// token (e.g. the workspace's GitHub App *installation* token) without pulling in a
// full GitHub client. The Cloudflare facade files through its App-authenticated
// `GitHubClient.createIssue`; this primitive is for the Node facade's per-tenant
// path once its installation-token minting is wired. `apiBase` defaults to public
// GitHub. The token must be the resolved tenant's credential — never a shared/env one.

export interface GitHubIssueTokenRequest {
  fetchImpl: FetchLike
  token: string
  owner: string
  repo: string
  title: string
  body: string
  apiBase?: string
}

/** File an issue and return its number + canonical web URL. */
export async function createGitHubIssueViaToken(
  req: GitHubIssueTokenRequest,
): Promise<{ number: number; url: string }> {
  const base = (req.apiBase ?? 'https://api.github.com').replace(/\/+$/, '')
  const url = `${base}/repos/${req.owner}/${req.repo}/issues`
  const res = await req.fetchImpl(url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${req.token}`,
      accept: 'application/vnd.github+json',
      'content-type': 'application/json',
      'user-agent': 'cat-factory',
      'x-github-api-version': '2022-11-28',
    },
    body: JSON.stringify({ title: req.title, body: req.body }),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`GitHub POST ${url} → ${res.status}: ${text.slice(0, 300)}`)
  }
  const json = (await res.json().catch(() => null)) as {
    number?: number
    html_url?: string
  } | null
  if (!json?.number) throw new Error('GitHub returned no issue number for the created issue')
  return { number: json.number, url: json.html_url ?? '' }
}
