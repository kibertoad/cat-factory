# @cat-factory/cli

## 0.2.2

### Patch Changes

- 720942a: Refresh the scaffolded project's pinned library versions so `cat-factory init`
  emits an up-to-date local-mode deployment. `@cat-factory/local-server` was pinned
  at `^0.19.5` (published `0.33.0`) and `@cat-factory/app` at `^0.47.7` (published
  `0.63.1`), so a freshly scaffolded project resolved badly stale backend/frontend
  libraries. Bumped both pins to the current published majors.

  Also note the local-mode sign-in step in the generated `README.md`: local mode
  requires sign-in, and because the CLI writes the provider PAT, the login screen
  offers "Sign in with configured PAT" — the generated run instructions now say so.

  Guard the pins against silent re-drift: `templates.pins.test.ts` fails the build
  if either caret no longer covers the current workspace version of
  `@cat-factory/local-server` / `@cat-factory/app`, so the pins can't quietly fall
  behind the libraries again. Also corrected the `templates.ts` comment, which
  claimed the caret picks up "patch/minor" releases — for these `0.x` libraries a
  caret only covers patches, so each minor bump needs a manual refresh here.

## 0.2.1

### Patch Changes

- 2961b05: Polish the scaffolded local deployment: `local/.env` now carries commented container→host
  reachability + security hints (the per-runtime host alias, the native-Linux-Docker
  `add-host-gateway`, the `AUTH_DEV_OPEN` lockdown note), the `.env.example` files mirror the
  chosen port/db/api-base instead of hardcoding `8787`, the generated README warns when `db:up`
  needs a non-docker runtime (Podman/Apple), and a `git init` nudge is printed for a fresh target
  dir. GitLab is now documented as a first-class local-mode provider (it gates CI + merges for real
  via `@cat-factory/gitlab`).

## 0.2.0

### Minor Changes

- 5c95baa: Add `@cat-factory/cli` — a bootstrap CLI (`cat-factory init`) that scaffolds a local-mode
  deployment (Node/local backend + frontend SPA, mirroring `deploy/local` + `deploy/frontend` but
  on the published libraries). It generates the crypto secrets (`AUTH_SESSION_SECRET` hex,
  `ENCRYPTION_KEY` base64) in the server's required formats, mints a GitHub/GitLab personal access
  token by opening the browser at the right pre-scoped URL and reading the pasted value, and writes
  the populated `.env` files with a `.gitignore` that keeps them out of version control.
