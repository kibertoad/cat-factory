import type { DelegatedFetch, PullRequestRef } from '@cat-factory/kernel'
import { apiGet } from './http.js'

// What a finished workflow PRODUCED, recovered from the repository rather than from the run.
//
// A `workflow_dispatch` workflow declares no outputs a caller can read, so the pull request it
// opened is not reported anywhere the platform can see. What IS true is that the platform told it
// which branch to work on, and a pull request is findable by its head. That is the whole trick, and
// it is why `branches.work` is on the brief.

/** One pull request as the REST list reports it. */
interface PullRequestSummary {
  number: number
  html_url: string
  head?: { ref?: string }
}

/**
 * The OPEN pull request whose head is the run's work branch, or undefined when there is none.
 *
 * Undefined is a real outcome rather than a failure: a delegated step may legitimately push without
 * opening one (a seed-only step, an executor whose policy is to push and let a later step open the
 * PR), and the engine records what it is given. Reporting a PR that is not there would put a dead
 * link on the block and hand the `ci` gate a number to poll that resolves to nothing.
 */
export async function pullRequestForBranch(
  fetchImpl: DelegatedFetch,
  input: { apiBase: string; token: string; owner: string; repo: string; branch: string },
): Promise<PullRequestRef | undefined> {
  const { owner, repo, branch } = input
  const path =
    `/repos/${owner}/${repo}/pulls` +
    `?state=open&head=${encodeURIComponent(`${owner}:${branch}`)}&per_page=5`
  const list = await apiGet<PullRequestSummary[]>(fetchImpl, {
    apiBase: input.apiBase,
    token: input.token,
    path,
  })
  // Matched on the head ref as well as the query, because `head` is a filter GitHub applies
  // leniently and a wrong PR recorded on the block is worse than none: the `ci` gate would then
  // poll somebody else's checks and the merger would consider somebody else's diff.
  const match = list.find((pr) => pr.head?.ref === branch)
  if (!match) return undefined
  return { url: match.html_url, number: match.number, branch }
}
