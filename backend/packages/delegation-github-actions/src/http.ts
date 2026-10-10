import type { DelegatedFetch } from '@cat-factory/kernel'

// The two GitHub REST calls this helper makes, and one place that decides what a non-2xx MEANS.
//
// Both are deliberately thin. A delegated executor is deployment code reaching its own system, and
// the one thing it owes the platform is an honest distinction between "still working", "finished"
// and "this call failed", so the error path carries the status line and a bounded body tail,
// which is what a person reading a refused dispatch actually needs.

/** How much of an error body is carried into the message: enough to name the fault, never a dump. */
const ERROR_BODY_CHARS = 400

export interface GitHubRequest {
  apiBase: string
  token: string
  /** An absolute path under the API base, already encoded. */
  path: string
}

/** A GitHub API call that failed, carrying the status and a bounded tail of what it said. */
export class GitHubActionsApiError extends Error {
  constructor(
    readonly status: number,
    readonly detail: string,
  ) {
    super(`GitHub API responded ${status}${detail ? `: ${detail}` : ''}`)
    this.name = 'GitHubActionsApiError'
  }
}

/** Read JSON from the API, throwing a status-carrying error on anything but a 2xx. */
export async function apiGet<T>(fetchImpl: DelegatedFetch, request: GitHubRequest): Promise<T> {
  const response = await fetchImpl(`${request.apiBase}${request.path}`, {
    method: 'GET',
    headers: headers(request.token),
  })
  if (!response.ok) throw new GitHubActionsApiError(response.status, await tail(response))
  return (await response.json()) as T
}

/**
 * POST a body and answer nothing.
 *
 * `workflow_dispatch` replies `204 No Content`, so there is deliberately no return value to
 * mistake for an identifier: what was started is found by {@link findRunByCorrelation}, not by
 * anything this call hands back.
 */
export async function apiPost(
  fetchImpl: DelegatedFetch,
  request: GitHubRequest & { body: unknown },
): Promise<void> {
  const response = await fetchImpl(`${request.apiBase}${request.path}`, {
    method: 'POST',
    headers: { ...headers(request.token), 'content-type': 'application/json' },
    body: JSON.stringify(request.body),
  })
  if (!response.ok) throw new GitHubActionsApiError(response.status, await tail(response))
}

function headers(token: string): Record<string, string> {
  return {
    accept: 'application/vnd.github+json',
    authorization: `Bearer ${token}`,
    'x-github-api-version': '2022-11-28',
    'user-agent': 'cat-factory-delegation-github-actions',
  }
}

/** A bounded tail of an error body; never throws, because a failure to read one is not the fault. */
async function tail(response: { text(): Promise<string> }): Promise<string> {
  try {
    return (await response.text()).slice(0, ERROR_BODY_CHARS)
  } catch {
    // silent-catch-ok: this runs INSIDE the construction of an error message, and the message that
    // matters is the status line already in hand. A failure to read the body must not replace a
    // usable "responded 403" with a stack about reading a stream.
    return ''
  }
}
