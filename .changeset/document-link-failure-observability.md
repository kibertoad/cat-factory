---
'@cat-factory/integrations': patch
'@cat-factory/server': patch
'@cat-factory/worker': patch
'@cat-factory/node-server': patch
'@cat-factory/app': patch
---

Surface the real cause when a task attachment can't be linked, instead of a bare
"1 attachment could not be linked".

- The context-linking path no longer swallows the error: `linkPending` now returns
  each failure with the server's own message, HTTP status, backend code, and the backend
  `details` bag, and the add-task toast shows the specific reason (e.g. a GitHub
  permission/visibility error) with a one-click "Copy details" button that puts a full
  diagnostic report on the clipboard (including the upstream GitHub status, kept distinct
  from the mapped HTTP status).
- `GitHubDocsProvider` classifies a failed doc read (403 no-access, primary/secondary
  rate-limit, 404/not-found, other) into a specific, actionable domain error carrying the
  repo coordinates + HTTP status, and logs it with full context — so a permission problem
  is no longer masked as an opaque 500 and is diagnosable server-side.
- `GitHubApiError` now retains the `rateLimited` (`x-ratelimit-remaining: 0`) signal
  structurally, so a GitHub PRIMARY rate-limit (reported as a 403, not a 429) is
  classified as a rate-limit rather than a spurious "missing read access" permission error.
- Added a reusable `copyAction` toast-action helper on `useCopyToClipboard`.
