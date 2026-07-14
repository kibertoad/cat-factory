---
'@cat-factory/kernel': minor
'@cat-factory/caching': minor
'@cat-factory/integrations': minor
'@cat-factory/server': minor
'@cat-factory/orchestration': patch
'@cat-factory/worker': patch
'@cat-factory/node-server': patch
---

Speed up the "add service from an existing repo" picker's typeahead, which stalled for
~17s per keystroke when a broad personal access token (PAT) backed the results.

The personal-repo branch re-walked the viewer's entire `GET /user/repos` set — up to ten
sequential GitHub pages — on every keystroke and only applied the query as an in-memory
filter afterwards, with nothing cached. Three changes:

- **Cache the enumeration.** New `AppCaches.viewerRepos` slice (grouped/keyed by user id):
  the picker's typeahead now filters a cached complete set in memory instead of forcing a
  fresh full walk per keystroke. Invalidated when the user's stored `github_pat` changes;
  a short (60s) TTL backstops repos created straight on GitHub. Pass-through on the Worker's
  isolate-safe profile (external state, not self-verifying), so it caches on Node/local
  where the PAT picker is the primary flow.
- **Parallelize the cold walk.** `FetchGitHubClient.listReposForToken` reads page 1, learns
  the page count from its `Link: rel="last"` header, and fetches the remaining pages
  concurrently — turning ~10 serial round-trips into ~2.
- The blank browse-all path (and its fail-closed access-projection refresh) is unchanged and
  stays uncached.

No repos are dropped: a literal GitHub `/search/repositories` call was deliberately avoided
because it can't reproduce the enumeration's `owner,collaborator,organization_member`
affiliation scope and would bury a low-star private repo in global results.
