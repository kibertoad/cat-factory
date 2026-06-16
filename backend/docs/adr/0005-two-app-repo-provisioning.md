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

### 1. Two App registrations; the owning App is recorded per installation

We register two Apps:

- **default (restricted)** — minimal permissions; never holds
  `Administration: write`, so its key cannot create or administer repos. Owns
  most installations. Configured via `GITHUB_APP_ID` + `GITHUB_APP_PRIVATE_KEY`.
- **privileged** — carries `Administration: write`. Configured via
  `GITHUB_PRIVILEGED_APP_ID` + `GITHUB_PRIVILEGED_APP_PRIVATE_KEY`.

An org opts into the privileged tier by **installing the privileged App** (one
App per org — it need not also install the default App). The allow-list is
therefore GitHub's own install state; there is no separate `GITHUB_PRIVILEGED_ORGS`
list. Because an installation id belongs to exactly one App on GitHub, each
binding records its **owning `appId`** (probed at connect via the app JWT —
`GET /app/installations/{id}` against each configured App until one sees it).
Rows created before the tier have a null `appId` and are treated as the default
App, so no backfill is needed.

### 2. Auth is resolved per installation, for every operation

`GitHubAppRegistry` (worker) holds both Apps and routes by the installation's
recorded `appId`: every installation-token mint and app-JWT call — reads, sync,
clone, push, repo creation — uses the key of the App that owns that installation.
So a privileged org runs entirely on the privileged App; everyone else on the
default. The `installationId → appId` mapping is cached per isolate (it's
immutable on GitHub). `FetchGitHubClient`, the bootstrapper / scanner /
agent-executor token callbacks, and the provisioning client all take the
registry.

### 3. Restricted installations are unchanged — no server-side fallback

For an installation owned by the default App the backend does **nothing new**:
the bootstrap modal keeps its "Create on GitHub" button (opens `github.com/new`
prefilled), the user creates the repo, and the bootstrapper pushes into it. No
queue, no admin-OAuth path, no error. `RepoProvisioningService.provision` returns
`delegated` and the existing pre-create flow takes over.

### 4. Guard the direct path on _granted_ permissions

For the create-repo endpoint, `RepoProvisioningService` (core) takes the
workspace's bound installation id and guards on the permissions the token
**actually carries** (`administration === 'write'`), read from the mint response
(`POST /app/installations/{id}/access_tokens`) — the App ∩ install-approval
intersection, exposed by `GitHubAppAuth` with no extra call. A proactive check
avoids a guaranteed 403; a live **403** (org policy) or **422** (name already
exists) also resolve to `delegated`, so the create is never a hard failure for
recoverable cases.

### 5. Surface capability to the UI

The connection (`GitHubConnection.canCreateRepos`) is true when the bound
installation's owning App is the privileged one (`GitHubAppRegistry.canCreateRepos`).
The bootstrap modal's "Create repository" button then **creates the repo
programmatically** via `POST /github/repos` (no GitHub page); for restricted
installations the same button opens GitHub's new-repo page as before.

### 6. Keep it a separate port; caller surface is the create-repo endpoint

Repo creation + permission introspection live in a new `GitHubProvisioningClient`
port rather than extending `GitHubClient`, so the common read/write client and
its fakes are untouched; the adapter (`FetchGitHubProvisioningClient`) follows
ADR 0001's Web-Crypto/`fetch`-only house style. Creation is triggered by the
modal's button via `POST /workspaces/:id/github/repos`, which uses the workspace's
bound installation — no new Workflow, no cross-App org lookup.

## Consequences

- Sensitive orgs run on a minimal-grant App; only orgs that installed the
  privileged App expose a key that can create/administer repos.
- A privileged org installs **one** App (the privileged one); the workspace binds
  to it and all operations use it. It should be installed **"All repositories"**
  so a just-created repo is immediately in scope for the subsequent push.
- Operators manage two App registrations and two private keys. Which tier an org
  is on is decided by which App it installed — nothing to keep in sync in config.
- A migration adds `github_installations.app_id` (nullable; null = default App).
- A misconfigured privileged App (lacking the grant) degrades to `delegated`
  (the create endpoint 409s), but since the UI shows the programmatic button for
  privileged installs, the App must actually carry `Administration: write`.
