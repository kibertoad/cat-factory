# @cat-factory/cli

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
