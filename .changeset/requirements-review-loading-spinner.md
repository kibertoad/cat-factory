---
'@cat-factory/app': patch
---

Fix a race in the requirements-review window where opening it the first time showed
"No review yet" even though a review existed — the initial `load()` fetch is async, so
the window rendered the empty state until the request resolved (forcing a reopen). The
store now tracks a per-block `loading` flag, and the window shows a spinner ("Loading the
review…") while the fetch is in flight, then renders the review as soon as it arrives.
