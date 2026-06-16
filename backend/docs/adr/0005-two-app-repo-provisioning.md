# ADR 0005: Two-App tiering for programmatic repository creation

- **Status:** Accepted
- **Date:** 2026-06-16
- **Context layer:** backend (`@cat-factory/core`, `@cat-factory/worker`), frontend (`app/`)

## Context

cat-factory wants to create a new GitHub repository for an org and immediately
operate on it (per ADR 0001, each org/workspace maps to a GitHub App
installation). Creating a repo via `POST /orgs/{org}/repos` requires the App to
hold the **`Administration: write`** repository permission, and the installation
must be scoped to **"All repositories"** so the freshly-created repo is
automatically in scope (an installation token can never reach repos the install
wasn't granted, and an App cannot expand its own scope — that needs a
user-to-server OAuth token from an org admin).

Granting `Administration: write` to _every_ installation is undesirable: for
sensitive orgs we want the smallest possible blast radius, so a leak of the
App's key can't create or administer repositories. But a single GitHub App has
**one permission set across all installations** — you cannot vary permissions
per org on one App. Raising an App's permissions also forces every installation
to re-approve, so the permission set is effectively global and sticky.

## Decisions

### 1. Two App registrations, chosen per org by tier

We register two Apps and resolve between them per org:

- **restricted** — the default, minimal-permission App (today's App). Used for
  every org not explicitly allow-listed. It never holds `Administration: write`,
  so its credentials cannot create or administer repos.
- **privileged** — a second App carrying `Administration: write`, used only for
  orgs explicitly listed in `GITHUB_PRIVILEGED_ORGS`. Configured via
  `GITHUB_PRIVILEGED_APP_ID` + `GITHUB_PRIVILEGED_APP_PRIVATE_KEY`.

Resolution **fails closed** (`resolveAppTier`): an org is privileged only when
explicitly listed; anything else — including a typo'd entry — degrades to
restricted. When no privileged App is configured, every org is restricted.

The privileged App is used **only to create repos** — it is a narrowly-scoped
"repo factory." Everything else (reads, sync, clone, push) continues to run on
the restricted App the workspace is bound to. So the privileged App has its own
installation per org, resolved on demand via the app JWT
(`GET /orgs/{org}/installation`) rather than from the workspace's stored binding.

### 2. Restricted orgs are unchanged — no server-side fallback

For restricted orgs the backend does **nothing new**: the bootstrap modal keeps
its existing "Create on GitHub" button (opens `github.com/new` prefilled), the
user creates the repo, and the bootstrapper pushes into it. There is no queue, no
admin-OAuth path, no error. `RepoProvisioningService.provision` returns
`delegated` and the existing pre-create flow takes over.

### 3. Guard the direct path on _granted_ permissions

When the org is privileged, `RepoProvisioningService` (core) resolves the
privileged App's installation, then guards on the permissions the token
**actually carries** (`administration === 'write'`), read from the mint response
(`POST /app/installations/{id}/access_tokens`) — the App ∩ install-approval
intersection. `GitHubAppAuth` caches and exposes these alongside the token, so a
warm isolate answers with no extra call. A proactive check avoids a guaranteed
403; a live **403** (org policy) or **422** (name already exists) also resolve to
`delegated`, so the create is never a hard failure for recoverable cases.

### 4. Surface capability to the UI

The connection (`GitHubConnection.canCreateRepos`) carries whether the account is
privileged, computed from the allow-list. When true, `BootstrapModal.vue` drops
the manual "Create on GitHub" / "Grant access" buttons — cat-factory creates the
repo during the bootstrap run instead.

### 5. Keep it a separate port

Repo creation + permission introspection live in a new `GitHubProvisioningClient`
port rather than extending `GitHubClient`. The common read/write client stays
implementable without the elevated grant, and existing implementors/fakes are
untouched. The adapter (`FetchGitHubProvisioningClient`) follows ADR 0001's
Web-Crypto/`fetch`-only house style.

### 6. Caller surface: the existing bootstrap run

Repo creation only exists as the first step of a "bootstrap repo" run, so
provisioning is wired into `ContainerRepoBootstrapper` (the existing endpoint →
`BootstrapService` → bootstrapper path) rather than a new endpoint or Workflow.
A privileged org creates the empty repo, then the same run pushes the initial
commit.

## Consequences

- Sensitive orgs run on a minimal grant; only allow-listed orgs expose an App
  that can create/administer repos.
- Privileged orgs must have **both** Apps installed: the privileged App (the repo
  factory) and the restricted App the workspace pushes with. The **restricted**
  App must be installed with **"All repositories"** there, so it can see and push
  to a just-created repo; otherwise the post-create pre-flight 404s and the user
  is told to grant access. Org settings may also require approval for App
  permissions — confirm with the org owner.
- Operators manage two App registrations, two private keys, and the
  `GITHUB_PRIVILEGED_ORGS` allow-list.
- A misconfigured privileged tier (App not installed, or lacking the grant)
  degrades to the restricted behaviour (the user creates the repo manually),
  except the UI will have hidden that button — so the allow-list and the App's
  installation must agree.
