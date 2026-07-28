---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/agents': minor
'@cat-factory/integrations': patch
'@cat-factory/conformance': minor
'@cat-factory/worker': patch
'@cat-factory/node-server': patch
'@cat-factory/app': minor
---

Make linking living fragments from GitHub work from a pasted URL end to end, and explain the
link button whenever it is inert.

Three field-reported failures on one surface, fixed together:

- **Pasting a full GitHub URL into the repo picker found nothing** ("no repositories found
  for <url>"): the picker's realtime search feeds the provider's tokenized name search, which a
  URL never matches. Contracts gains a pure `parseRepoWebUrl` (GitHub `tree`/`blob`/`raw` and
  GitLab `/-/` shapes, subgroups included), and `GitHubSyncService.listAvailableRepos` now
  collapses a pasted URL to its `owner/name` slug AND resolves that slug with a direct
  `getRepo` point-read merged ahead of the search results — a reachable repo resolves even when
  the provider's search misses it.
- **Bulk-import by directory URL**: the Documents tab takes a pasted GitHub file or folder URL,
  resolves the repo by slug (no search dependency), opens the tree browser at that folder, and
  the browser's multi-file mode gains per-file checkboxes plus a select-all row — so a whole
  directory of documents can be checked and linked as living fragments in one action.
- **"Link as living fragment" disabled with no explanation**: the button now states, beside it,
  exactly what is missing (no source chosen / no repository / no files ticked / empty ref).
- **Account-tier repo sources failed with "No GitHub installation is available for this
  scope"** even when the repo was browsable: the account-scope resolver matched only
  `installation.accountId`, which is null for a per-workspace PAT connect and a GitHub account
  id for local PAT mode's synthetic rows. The shared `createTierInstallationResolvers`
  (`@cat-factory/agents`, wired by both facades for fragments AND skills) now falls back
  through the account's own boards, via the new `WorkspaceRepository.listByAccount` (D1 ⇄
  Drizzle, conformance-asserted).
