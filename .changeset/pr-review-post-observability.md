---
'@cat-factory/contracts': patch
'@cat-factory/kernel': patch
'@cat-factory/server': patch
'@cat-factory/orchestration': patch
'@cat-factory/app': patch
---

Make the PR deep-review `post` resolution observable, partial-tolerant, and retryable — and fix its root-cause 422.

Previously `post` submitted the selected findings as ONE atomic `COMMENT` review. GitHub rejects the whole review if any inline comment anchors a line outside the PR diff ("Line could not be resolved"), so a single bad finding failed all of them; the run then failed with the error visible only after closing the window, which read as a stuck "Posting…" spinner.

Now:

- **Root cause fixed.** The engine parses the PR diff (`computeCommentableLines`) and folds any finding whose line isn't in the diff into the summary comment instead of sending an inline comment GitHub would reject.
- **Per-comment posting + observability.** `RepoFiles.createReview` (and the underlying `GitHubClient`/`VcsClient` port) now posts each inline comment individually and returns a per-comment `CreateReviewResult`, so anchorable comments land while the rest are reported. The outcome is recorded on `step.prReview.postReport` (how many of how many posted, per-finding failures + reasons, folded count), which the deep-review window renders.
- **No more stuck spinner; retry only the posting.** A partial or failed post re-parks the review at `awaiting_selection` carrying the report (instead of failing the whole run), so the human sees what happened and can retry ONLY the posting — `post` skips findings already posted (`postedFindingIds`) so a retry never double-posts — or switch to `fix`/`finish`.
