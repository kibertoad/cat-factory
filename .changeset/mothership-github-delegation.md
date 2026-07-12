---
'@cat-factory/kernel': minor
'@cat-factory/server': minor
'@cat-factory/worker': minor
'@cat-factory/node-server': minor
'@cat-factory/local-server': minor
---

Mothership-mode GitHub support + remote persistence for environment self-test runs.

**GitHub token delegation.** The mothership now serves a machine-authed
`POST /internal/github/installation-token` (mounted on both facades, like the persistence
RPC): a mothership-mode local node presents its machine token and an installation id, the
call is rate-limited per node (fixed window on the token's signed `nodeId`) and
account-scoped off the installation's own account binding (live row + `accountId` in the
token scope, uniform 404 otherwise), and the mothership's GitHub App mints a short-lived
installation token **repo-scoped via `repository_ids`** to the live App-linked
`github_repos` projection for that installation (`user_pat`-linked rows excluded; no
linked repos ⇒ 404) — never an installation-wide token, and never served from or written
into the engine's unscoped token cache. Every mint/denial/failure is audit-logged with
the node + user ids (the new kernel port method backing the scoping read is
`RepoProjectionRepository.listByInstallation`, mirrored D1 ⇄ Drizzle). A mothership-mode
local node with no `GITHUB_PAT` now consumes these tokens through the new
`DelegatedAppTokenSource` — wiring the push/clone token mint AND a full `FetchGitHubClient`
(gates, merge, repo-link, `resolveRunRepoContext`/RepoFiles) off the org's GitHub App, with
the App private key never leaving the mothership. An explicitly configured PAT still wins;
`GITHUB_PAT` is now optional in mothership mode.

**Environment self-test remote persistence.** The `environment_test_runs` store is now on
the mothership persistence allow-list (`get`/`update`/`listRunningByWorkspace` workspace-
scoped, record-based `insert` bound on the run's `workspaceId` field), so a mothership-mode
node persists and lists its self-test runs remotely instead of failing with
`unknown_method`. Its former blocker — the self-test's GitHub branch create/delete — is
served by the delegation endpoint above. A FULL mothership-mode self-test still waits on
the provisioning writes (`environmentRegistryRepository.insert`/`update`, the
secrets-delegation slice); until then the run fails cleanly at the provisioning stage with
cleanup.
