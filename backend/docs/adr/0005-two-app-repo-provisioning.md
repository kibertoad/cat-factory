# ADR 0005: Two-App tiering for programmatic repository creation

- **Status:** Proposed
- **Date:** 2026-06-16
- **Context layer:** backend (`@cat-factory/core`, `@cat-factory/worker`)

## Context

cat-factory wants to create a new GitHub repository for an org and immediately
operate on it (per ADR 0001, each org/workspace maps to a GitHub App
installation). Creating a repo via `POST /orgs/{org}/repos` requires the App to
hold the **`Administration: write`** repository permission, and the installation
must be scoped to **"All repositories"** so the freshly-created repo is
automatically in scope (an installation token can never reach repos the install
wasn't granted, and an App cannot expand its own scope — that needs a
user-to-server OAuth token from an org admin).

Granting `Administration: write` to *every* installation is undesirable: for
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

`GitHubAppRegistry` (worker) owns this resolution and hands back the right
`GitHubAppAuth`.

### 2. Guard the direct path on *granted* permissions, not on which App

The decision to create directly is driven by the permissions the installation
token **actually carries** (`administration === 'write'`), read from the token
mint response (`POST /app/installations/{id}/access_tokens`), which already
returns the App ∩ install-approval intersection. `GitHubAppAuth` now caches and
exposes these alongside the token, so a warm isolate answers with no extra call.

This is belt-and-suspenders with the tier routing: tier picks the credentials;
the granted-permission check confirms the credentials can actually do the job
before we try. A live **403** (e.g. an org policy blocking the App) is treated as
authoritative and routes to the same fallback as a missing grant.

### 3. Fallback for the restricted tier

`RepoProvisioningService` (core) orchestrates: check capability → create
directly, else delegate to a pluggable `RepoProvisionFallback`
(`insufficient_permissions` or `forbidden`). The fallback is where a
restricted-tier request goes — queue for an org-admin OAuth flow, open a tracking
issue, notify a human — and is intentionally left to the wiring layer.

### 4. Keep it a separate port

Repo creation + permission introspection live in a new `GitHubProvisioningClient`
port rather than extending `GitHubClient`. The common read/write client stays
implementable without the elevated grant, and existing implementors/fakes are
untouched. The adapter (`FetchGitHubProvisioningClient`) follows ADR 0001's
Web-Crypto/`fetch`-only house style.

## Consequences

- Sensitive orgs run on a minimal grant; only allow-listed orgs expose an App
  that can create/administer repos.
- The privileged App must be installed with **"All repositories"** on its orgs
  for created repos to be in scope automatically; otherwise creation succeeds but
  the restricted App still can't see the new repo. Org settings may also require
  approval for App permissions — confirm with the org owner.
- Operators manage two App registrations, two private keys, and the
  `GITHUB_PRIVILEGED_ORGS` allow-list.

## Wiring (not yet done)

This ADR ships the building blocks (`GitHubAppRegistry`,
`FetchGitHubProvisioningClient`, `RepoProvisioningService`, config + env). They
are not yet hooked into the DI container or exposed via an endpoint; doing so
requires choosing a concrete fallback (queue vs. issue vs. manual) and a caller
surface.
