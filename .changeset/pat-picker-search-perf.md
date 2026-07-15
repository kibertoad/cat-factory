---
'@cat-factory/kernel': minor
'@cat-factory/caching': minor
'@cat-factory/local-server': patch
'@cat-factory/integrations': patch
---

perf(github): fix the slow add-service repo picker search on the local (workspace-PAT) path

The "add service from repo" typeahead stalled for seconds per keystroke when local mode's
`GITHUB_PAT` backed the picker: `PatGitHubClient.searchInstallationRepos` re-walked the
PAT's entire `GET /user/repos` set — up to 20 SEQUENTIAL pages — on every search request,
with nothing cached (the counterpart viewer-PAT branch was already fixed, but the
workspace-credential branch kept its own older serial walk).

- `PatGitHubClient.listInstallationRepos` now delegates to the shared
  `FetchGitHubClient.listReposForToken` walk (page 1 reveals the page count via
  `Link: rel="last"`, the remaining pages fetch concurrently — ~2 round-trips instead of
  up to 20 serial ones) and re-stamps the rows as workspace-wide (`linkedVia: 'app'`).
  Note the enumeration cap is now the shared walk's 10 pages (1000 repos, flagged
  `truncated`) instead of the old silent 20.
- New `AppCaches.patInstallationRepos` slice (grouped/keyed by installation id, 60s TTL;
  pass-through on the Worker's isolate-safe profile): the picker typeahead filters a
  cached complete enumeration in memory instead of re-walking `/user/repos` per
  keystroke. The blank browse-all stays live/uncached. The local PAT is env-fixed per
  boot, so there is no swap-write to invalidate on — the short TTL is the coherence
  story, mirroring `viewerRepos`.
- `GitHubSyncService.listAvailableRepos` now runs its three independent reads (the
  tracked-projection list, the App-side lookup, the viewer-PAT expansion) as one
  concurrent wave instead of serially, so a cold PAT enumeration no longer stacks on top
  of the App lookup's latency.
