---
'@cat-factory/contracts': minor
'@cat-factory/integrations': minor
'@cat-factory/server': minor
'@cat-factory/app': minor
---

feat(github): search available repos server-side in the "add service from repo" picker.
The picker no longer prefetches the entire installation repo list on open (slow for a wide
App install or PAT with hundreds of repos, and it blocked filtering until the whole list
loaded). Instead the user types at least 3 characters and the (debounced) query is sent to
`GET /github/available-repos?q=…`, which returns only the `owner/name` matches. The `q`
param is optional, so the repo-link management panel's browse-all is unchanged. The now-moot
manual "refresh list" button is removed (each search hits GitHub live).
