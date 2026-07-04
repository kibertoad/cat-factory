# Initiative: personal-PAT repo access + fail-closed frame redaction

**Status:** phase 1 landed (list · link · run · redact) · **Owner:** core · **Started:** 2026-07-04

> Durable source of truth for this cross-cutting change. Read it FIRST before picking up a
> follow-up slice; update the checklist at the end of each PR.

## Goal & rationale

A workspace's GitHub **App installation** only reaches the repos it was granted. A developer
often has a **personal access token (PAT)** — already a first-class per-user secret
(`user_secrets`, kind `github_pat`) — that can reach _more_ repos than the App. Two gaps:

1. **The repo picker only listed App-installation repos**, so a user couldn't add a repo their
   own PAT could reach on the hosted (Cloudflare / Node) facades — only local mode (whose single
   env `GITHUB_PAT` is the workspace credential) could.
2. **No per-user authorization on the board.** Once a repo is linked via one member's PAT, other
   members — who may have no access to it — would still see the service's contents.

**End state (phase 1, done):** the picker expands with the viewer's PAT-reachable repos; linking
one creates a **personal service** (`GitHubRepo.linkedVia === 'user_pat'`); at run time the
initiator-preferring token mint already uses the initiator's PAT (pre-existing); and the board
**redacts** a personal frame for any member who can't reach its repo — showing only the internal
cat-factory block id + a "Permission denied" placeholder (**fail closed**).

## The model

- **`github_repos.linked_via`** (`'app'` | `'user_pat'`, default `'app'`): how a repo entered the
  projection. `'app'` = reachable via the shared installation (visible to every member); `'user_pat'`
  = reachable only via the linker's PAT. Link-owned (sync never overwrites it).
- **`github_user_repo_access`** (`(user_id, repo_github_id)`): the per-user "repos my PAT can reach"
  projection — the **fail-closed cache** the redaction reads so the hot snapshot path makes **no
  live GitHub call**. Populated when a user enumerates their PAT repos (picker browse / link) and
  cleared when they remove their PAT. A member with no row for a personal repo is treated as having
  **no access** (self-heals once they connect their PAT). Kernel port `UserRepoAccessRepository`.
- **Access rule:** an `'app'` frame is visible to everyone; a `'user_pat'` frame is visible to a
  member iff they are recorded as able to reach its repo (or no signed-in user ⇒ redact).

## Reference implementation (the target pattern)

- Picker/link expansion: `GitHubSyncService.listAvailableRepos` / `linkRepo`
  (`backend/packages/integrations/src/modules/github/GitHubSyncService.ts`) — merge the viewer's
  `GitHubClient.listReposForToken(token)` results, mark them `personal`, record access; link a
  personal repo via `getRepoForToken` when the App can't reach it. The controllers resolve the
  viewer's PAT: `GitHubController` (`resolveViewerPat`) + `BoardController.addServiceFromRepo`.
- Redaction: `backend/packages/server/src/modules/workspaces/redactFrames.ts`
  (`resolveDeniedFrameIds` + pure `redactBoard`), wired into `WorkspaceController` after the
  snapshot is assembled. Frontend: `BlockNode.vue` renders the locked stub on `block.accessDenied`
  (`data-testid="frame-access-denied"`); i18n `board.frame.accessDenied.{title,hint}`.
- Token reads: `FetchGitHubClient.listReposForToken` / `getRepoForToken` (the only calls using an
  explicit caller-supplied bearer). Optional on the `GitHubClient` port (GitLab/others skip them).

## Conventions & gotchas

- **`linked_via` / `github_user_repo_access` mirror D1 ⇄ Drizzle** (parity is mandatory). D1
  migration `0038_personal_repo_access.sql`; Drizzle `20260704164934_personal_repo_access`. Parity
  asserted by `defineUserRepoAccessSuite` (conformance), run from both facades. The mothership drift
  guard classifies the new Drizzle repo as `local` (a per-user store, not proxied org state).
- **Keep helper methods OFF a Drizzle repo's prototype** — the mothership drift guard reflects every
  public method; use module-level functions (see `upsertBatches` in `userRepoAccess.ts`).
- **The picker/link/redaction are no-ops without their wiring** (no viewer PAT, no `userRepoAccess`,
  GitHub off) — so tests/conformance with GitHub off run unchanged.
- **A personal-token failure must never fail the whole picker.** `viewerPatRepos` catches any
  `listReposForToken` error (expired/revoked PAT, network) and degrades to App-only — a stored PAT
  that still decrypts but no longer authenticates must not 500 the available-repos listing.
- **The access-cache refresh runs only on a blank browse-all, and never REPLACES on a truncated
  enumeration.** A per-search refresh would rewrite the user's whole recorded set each keystroke; and
  `listReposForToken` caps at a page limit (surfaced as `Paged.truncated`), so a truncated result is
  recorded ADDITIVELY (`recordAccessible`) — a truncated `replaceForUser` would drop reachable repos
  and fail-closed-redact the user's own frames.

## Consequences of removing the legacy repo→block link (same change)

The old `github_repos.block_id` repo↔frame link (Mechanism A) was removed; the account-owned
**`Service`** (`getByFrameBlock` → `repoGithubId`) is now the **sole** repo↔frame linkage. This
simplified `resolveRepoTarget` (Service-only, `serviceRepository` now required) and the redaction's
frame→repo resolution. Bootstrap now binds the frame's `Service` (via `projectBootstrappedRepo` +
`serviceRepository.update`) instead of setting `block_id`; local `linkRepo` upserts/updates a
`Service`. The frontend resolves a frame's repo through `serviceByFrameBlock`, not `repo.blockId`.

## Per-item status checklist

| Area          | Item                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Status |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| schema        | `linked_via` column + `github_user_repo_access` (D1 + Drizzle + migrations)                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | done   |
| ports         | `UserRepoAccessRepository`, `GitHubClient.listReposForToken`/`getRepoForToken`                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | done   |
| picker        | `listAvailableRepos` PAT merge + `personal` badge                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | done   |
| link          | `linkRepo` personal path + access recording + PAT revoke on secret removal                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | done   |
| redaction     | `redactFrames` resolver + pure redactor + `WorkspaceController` wiring                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | done   |
| frontend      | `BlockNode.vue` locked stub + i18n (8 locales) + picker badge                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | done   |
| parity        | `defineUserRepoAccessSuite` (D1 ⇄ Drizzle)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | done   |
| legacy        | remove `github_repos.block_id` (Mechanism A) end to end                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | done   |
| **follow-up** | **monorepo-subdirectory browse + PR/issue projection sync for personal repos**                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | todo   |
| **follow-up** | **cross-workspace mount of a personal repo — SECURITY fail-open** (redaction resolves `linked_via` from the viewing workspace's projection only, so a personal repo mounted from a sibling workspace is classified `app` and NOT redacted; a redaction-only fix can't distinguish it from a legitimately-mounted App repo the viewer never linked, so the proper fix carries `linkedVia` on the account-owned `Service` — spans workspaces natively — or an account-scoped classification read; gate personal-service cross-workspace mounts until then) | todo   |
| **follow-up** | **refresh a user's access projection on PAT save** (today it refreshes on picker browse / link; a stored-but-never-browsed PAT grants no visibility until first browse)                                                                                                                                                                                                                                                                                                                                                                                  | todo   |
