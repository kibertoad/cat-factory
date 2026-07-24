---
'@cat-factory/kernel': patch
'@cat-factory/server': patch
'@cat-factory/gates': patch
'@cat-factory/gitlab': patch
---

Close three gaps in the `human-review` PR gate:

- **Reviewer "Request changes" summaries are no longer ignored.** The gate only reacted to
  inline review threads and plain conversation comments, so a reviewer who requested changes with
  their feedback in the review's top-level summary box (no inline line comments) was invisible —
  the run waited indefinitely for an approval that would never come. The review `body` is now read
  (`FetchGitHubClient` + the `GitHubPullRequestReview` port), surfaced on the snapshot as
  `reviewSummaries`, and folded into the gate's outstanding-feedback set so it dispatches the
  fixer like any other comment.
- **A standing `CHANGES_REQUESTED` now blocks advancement** even when the required approval count
  is met by other reviewers (`PullRequestReviewSnapshot.changesRequested` + `isApproved`), matching
  GitHub's own merge rule so the gate can't sign off a PR GitHub would refuse to merge.
- **Approval reduction is order-independent**: reviews are sorted by `submittedAt` before the
  "latest standing review per author" reduction, instead of trusting the API's array order.
