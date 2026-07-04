---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/integrations': minor
'@cat-factory/server': minor
'@cat-factory/orchestration': minor
'@cat-factory/worker': minor
'@cat-factory/node-server': minor
'@cat-factory/local-server': minor
'@cat-factory/gitlab': patch
'@cat-factory/app': minor
---

Personal-PAT repo access + fail-closed board redaction, and removal of the legacy repo→block link.

- **Expand the repo picker with your own PAT (all facades).** A user's stored GitHub PAT
  (`user_secrets` kind `github_pat`) now surfaces repos it can reach beyond the workspace's GitHub
  App grant — even on the hosted Cloudflare/Node facades. Linking one creates a **personal service**
  (`GitHubRepo.linkedVia === 'user_pat'`); runs against it already use the initiator's PAT.
- **Fail-closed frame redaction.** A service frame backed by a repo linked via another member's PAT
  is hidden from members who can't reach it: the board snapshot scrubs the frame to just its
  internal id + a "Permission denied" placeholder and drops its subtree. Access is a fail-closed
  per-user projection (`github_user_repo_access`), refreshed when a user enumerates their PAT repos
  and cleared when they remove their PAT — no live GitHub call on the snapshot path.
- **New:** `github_repos.linked_via` column + `github_user_repo_access` table (mirrored D1 ⇄
  Drizzle, with a cross-runtime conformance suite); kernel `UserRepoAccessRepository` port and
  optional `GitHubClient.listReposForToken`/`getRepoForToken`; `Block.accessDenied` +
  `GitHubAvailableRepo.personal` wire fields.

**Breaking (pre-1.0, no migration):** the legacy `github_repos.block_id` repo↔frame link is removed
— the account-owned `Service` (`getByFrameBlock` → `repoGithubId`) is now the SOLE repo↔frame
linkage. `RepoProjectionRepository.linkBlock` and `GitHubRepo.blockId` are gone; `resolveRepoTarget`
now requires a `serviceRepository`; the `RepoBootstrapper` port's `linkRepoToBlock` is replaced by
`projectBootstrappedRepo` (the caller binds the frame's `Service`). Existing rows' `block_id` is
dropped; repos remain reachable through their `Service`.
