---
'@cat-factory/kernel': minor
'@cat-factory/server': minor
'@cat-factory/integrations': minor
'@cat-factory/gitlab': minor
'@cat-factory/local-server': minor
---

Import-from-repo picker: find and link accessible repos in realtime instead of enumerating the whole installation and filtering in memory. The old path listed every installation repo (capped at a bounded page count) then substring-filtered client-of-the-cap — so on a wide App install a repo beyond that window returned "no matches" for a repo you actually had access to, and every keystroke re-fetched all pages. Two new `GitHubClient` primitives fix it end to end: `searchInstallationRepos` issues one bounded, account-scoped GitHub search per query, and `getRepoById` point-reads the picked repo by id when linking it (so a repo surfaced by search from beyond the enumeration cap links instead of spuriously 409-ing). Blank-query browse-all is unchanged; PAT (local) and GitLab connections filter their bounded token listing.
