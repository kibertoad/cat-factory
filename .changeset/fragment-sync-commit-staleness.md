---
'@cat-factory/kernel': minor
'@cat-factory/contracts': minor
'@cat-factory/agents': minor
'@cat-factory/server': minor
'@cat-factory/gitlab': minor
'@cat-factory/worker': minor
'@cat-factory/node-server': minor
'@cat-factory/app': minor
---

Fragment GitHub-source staleness is now a lightweight commit-version check.

The full fragment bodies were already cached on our side; the "check for changes"
probe previously re-listed the whole source directory and hashed every blob sha.
It now reads only the source directory's current head commit sha and compares it to
the commit the source was last synced to — a single cheap GitHub/GitLab call, no
directory listing or file reads.

Breaking (pre-1.0, no migration): `FragmentSource`/`FragmentSyncResult` now expose
`lastSyncedCommit` instead of `lastSyncedSha`, and `FragmentSourceStatus` is
`{ changed, lastSyncedCommit, remoteCommit }` (the per-file `changedCount`/`remoteSha`
are gone — the resync badge is now a plain "changes available" indicator). A new
`latestCommitSha` port method is added to `GitHubClient` and `VcsClient`. The physical
`fragment_sources.last_synced_sha` column is unchanged and reused to store the commit
sha, so no database migration is required; existing rows re-derive their commit on the
next sync.
