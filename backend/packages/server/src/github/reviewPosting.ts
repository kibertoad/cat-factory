import type {
  CreateReviewInput,
  CreateReviewResult,
  GitHubRepoRef,
  ReviewCommentOutcome,
} from '@cat-factory/kernel'

// PR deep-review "post" resolution — the GitHub side of publishing the human-selected findings.
// Extracted from FetchGitHubClient so the client stays a thin transport and this cohesive concern
// (per-comment posting + partial-success reporting) lives in one place. Talks to GitHub only
// through the injected `request` executor, so it stays runtime-neutral and easy to unit-test.

/** The narrow slice of `FetchGitHubClient.request` this helper needs. */
export type GitHubRequestFn = (
  path: string,
  opts: { installationId: number; method?: string; body?: unknown },
) => Promise<{ json: unknown }>

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

/**
 * Publish a PR review's findings on GitHub, posting each inline comment INDIVIDUALLY rather than as
 * one atomic batched review (`POST …/reviews` with the whole `comments` array). A batched review is
 * all-or-nothing: a single comment anchored to a line outside the PR diff 422s ("Line could not be
 * resolved") and rejects EVERY comment. Posting per-comment lets the anchorable ones land and
 * reports the rest, so a partial post is a legible, retryable outcome — the observability the
 * deep-review "post" resolution needs.
 *
 * Each inline comment needs the head commit sha (`commit_id`). Resolve it once up front; if that
 * fails there is nothing to anchor against, so report every comment (and the body) failed rather
 * than throwing — the caller records an all-failed attempt and re-parks.
 */
export async function postPrReview(
  request: GitHubRequestFn,
  installationId: number,
  ref: GitHubRepoRef,
  number: number,
  input: CreateReviewInput,
): Promise<CreateReviewResult> {
  const base = `/repos/${ref.owner}/${ref.repo}`
  let headSha: string
  try {
    const { json } = await request(`${base}/pulls/${number}`, { installationId })
    const sha = (json as { head?: { sha?: string } }).head?.sha
    if (!sha) throw new Error(`Pull request #${number} has no resolvable head commit`)
    headSha = sha
  } catch (error) {
    const reason = errorMessage(error)
    return {
      comments: input.comments.map(() => ({ posted: false, error: reason })),
      bodyPosted: input.body ? false : null,
      bodyError: input.body ? reason : undefined,
    }
  }

  const comments: ReviewCommentOutcome[] = []
  for (const c of input.comments) {
    try {
      // A standalone PR review comment anchored to a diff line (`side` defaults to RIGHT — the
      // head). This threads inline on the file exactly like a batched review's comment would.
      await request(`${base}/pulls/${number}/comments`, {
        installationId,
        method: 'POST',
        body: {
          body: c.body,
          commit_id: headSha,
          path: c.path,
          line: c.line,
          side: c.side ?? 'RIGHT',
        },
      })
      comments.push({ posted: true })
    } catch (error) {
      comments.push({ posted: false, error: errorMessage(error) })
    }
  }

  // The summary + any unanchored findings go as a general PR conversation comment (the issue-
  // comments endpoint), so the review's prose lands even when it carries no inline comments.
  let bodyPosted: boolean | null = null
  let bodyError: string | undefined
  if (input.body) {
    try {
      await request(`${base}/issues/${number}/comments`, {
        installationId,
        method: 'POST',
        body: { body: input.body },
      })
      bodyPosted = true
    } catch (error) {
      bodyPosted = false
      bodyError = errorMessage(error)
    }
  }

  return { comments, bodyPosted, bodyError }
}
