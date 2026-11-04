import { type GitHubRepoRef, sameIssueDescription } from '@cat-factory/kernel'
import { GitHubApiError } from './githubHttpHelpers.js'
import type { GitHubRequestFn } from './reviewPosting.js'

// The issue-tracker writeback's writes against a GitHub issue: close as resolved, apply a label,
// replace the body. Extracted from FetchGitHubClient so the client stays a thin transport; each
// talks to GitHub only through the injected `request` executor.

/** GitHub's create-label endpoint requires a colour; a neutral grey. */
const DEFAULT_LABEL_COLOR = 'ededed'

/** Close an issue as resolved (`state_reason: completed`). Closing a closed issue is not an error. */
export async function closeIssue(
  request: GitHubRequestFn,
  installationId: number,
  ref: GitHubRepoRef,
  number: number,
): Promise<void> {
  await request(`/repos/${ref.owner}/${ref.repo}/issues/${number}`, {
    installationId,
    method: 'PATCH',
    body: { state: 'closed', state_reason: 'completed' },
  })
}

/** Replace an issue's body when it differs from the stored one (read, compare, PATCH). */
export async function replaceIssueBody(
  request: GitHubRequestFn,
  installationId: number,
  ref: GitHubRepoRef,
  number: number,
  body: string,
): Promise<'updated' | 'unchanged'> {
  const path = `/repos/${ref.owner}/${ref.repo}/issues/${number}`
  const { json } = await request(path, { installationId })
  if (sameIssueDescription((json as { body?: string | null } | null)?.body, body)) {
    return 'unchanged'
  }
  await request(path, { installationId, method: 'PATCH', body: { body } })
  return 'updated'
}

/** Apply a label, creating it in the repository first when it does not exist yet. */
export async function applyIssueLabel(
  request: GitHubRequestFn,
  installationId: number,
  ref: GitHubRepoRef,
  number: number,
  label: string,
): Promise<void> {
  // Ensure the label exists first: a 422 means it already does, which is fine. (Relying on the
  // add-labels endpoint to auto-create is undocumented behaviour.) GitHub's create-label endpoint
  // requires BOTH `name` and `color`; omitting the colour makes every create fail 422 (missing
  // field), which the catch below would otherwise mistake for "already exists".
  try {
    await request(`/repos/${ref.owner}/${ref.repo}/labels`, {
      installationId,
      method: 'POST',
      body: { name: label, color: DEFAULT_LABEL_COLOR },
    })
  } catch (err) {
    if (!(err instanceof GitHubApiError && err.status === 422)) throw err
  }
  await request(`/repos/${ref.owner}/${ref.repo}/issues/${number}/labels`, {
    installationId,
    method: 'POST',
    body: { labels: [label] },
  })
}
