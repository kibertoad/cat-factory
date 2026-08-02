import type {
  CreateReviewInput,
  CreateReviewResult,
  ReviewCommentOutcome,
} from '@cat-factory/kernel'

// PR deep-review "post" resolution — the GitLab side of publishing the human-selected findings,
// the mirror of `@cat-factory/server`'s `reviewPosting.ts` (the GitHub half). It lives beside the
// client rather than inside it for the same reason: the client stays a thin transport and this
// cohesive concern (per-comment posting + partial-success reporting) lives in one place. Talks to
// GitLab only through the injected `request` executor, so it stays runtime-neutral and unit-testable.

/** The narrow slice of `FetchGitLabClient.request` this helper needs. */
export type GitLabRequestFn = (
  path: string,
  opts: { method?: string; body?: unknown },
) => Promise<{ json: unknown }>

/** The commit refs every inline discussion must be anchored against (`GET /merge_requests/:iid`). */
interface GlDiffRefs {
  base_sha?: string | null
  start_sha?: string | null
  head_sha?: string | null
}

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

/**
 * Publish an MR review's findings on GitLab, posting each inline comment INDIVIDUALLY as its own
 * diff discussion — behaviourally identical to the GitHub half, and for the same reason: a comment
 * anchored to a line outside the MR diff is rejected, and batching would let one un-anchorable
 * finding reject every other. Posting per-comment lets the anchorable ones land and reports the
 * rest, so a partial post stays a legible, retryable outcome.
 *
 * GitLab anchors a diff note on the MR's `diff_refs` triplet (`base_sha` / `start_sha` /
 * `head_sha`) rather than on a single head commit. Resolve it once up front; if that fails there is
 * nothing to anchor against, so report every comment (and the body) failed rather than throwing —
 * the caller records an all-failed attempt and re-parks, exactly as on GitHub.
 *
 * `CreateReviewInput.event` is deliberately unused, as it is on the GitHub side: the deep-review
 * flow posts advisory `COMMENT` reviews, and turning an `APPROVE` into a real GitLab approval would
 * make the two providers behave differently from the same input.
 */
export async function postMrReview(
  request: GitLabRequestFn,
  number: number,
  input: CreateReviewInput,
): Promise<CreateReviewResult> {
  let refs: Required<GlDiffRefs>
  try {
    const { json } = await request(`/merge_requests/${number}`, {})
    const diffRefs = (json as { diff_refs?: GlDiffRefs | null } | null)?.diff_refs
    const base = diffRefs?.base_sha
    const head = diffRefs?.head_sha
    if (!base || !head) {
      throw new Error(`Merge request !${number} has no resolvable diff refs to anchor comments on`)
    }
    // `start_sha` is the diff's starting commit; GitLab fills it for every MR with a diff, but fall
    // back to `base_sha` rather than failing the whole post over the one optional leg.
    refs = { base_sha: base, start_sha: diffRefs?.start_sha ?? base, head_sha: head }
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
      // `side` selects which side of the diff the line belongs to: RIGHT (the default, the head) is
      // a `new_line` anchor, LEFT (a base/removed line) an `old_line` one. Both paths are always
      // sent — GitLab needs `old_path` to locate the file on the base even for a new-line anchor.
      //
      // The finding names the file's path on the HEAD, which is also its path on the base for
      // everything except a RENAME: `CreateReviewComment` carries no `previousPath`, so a comment
      // on a renamed file anchors against a base path GitLab has no record of and is rejected.
      // That is a bounded, reported outcome rather than a silent loss — this comment comes back
      // `posted: false` and the caller folds the finding into the summary body, which is the same
      // disposition as any other un-anchorable line. Carrying the base path would mean widening the
      // port for one provider's addressing, so it stays out until a finding needs it.
      const anchor = c.side === 'LEFT' ? { old_line: c.line } : { new_line: c.line }
      await request(`/merge_requests/${number}/discussions`, {
        method: 'POST',
        body: {
          body: c.body,
          position: {
            position_type: 'text',
            base_sha: refs.base_sha,
            start_sha: refs.start_sha,
            head_sha: refs.head_sha,
            new_path: c.path,
            old_path: c.path,
            ...anchor,
          },
        },
      })
      comments.push({ posted: true })
    } catch (error) {
      comments.push({ posted: false, error: errorMessage(error) })
    }
  }

  // The summary + any unanchored findings go as a general MR conversation note (the notes
  // endpoint), so the review's prose lands even when it carries no inline comments.
  let bodyPosted: boolean | null = null
  let bodyError: string | undefined
  if (input.body) {
    try {
      await request(`/merge_requests/${number}/notes`, {
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
