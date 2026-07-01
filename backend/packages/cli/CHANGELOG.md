# @cat-factory/cli

## 0.3.1

### Patch Changes

- c40736e: Refresh the scaffolded `@cat-factory/app` pin to `^0.64.0` so `cat-factory init` generates a
  frontend deployment against the current published layer (the `^0.63.1` pin no longer covered
  `0.64.0`).

## 0.3.0

### Minor Changes

- fb699f3: Add the `cat-factory k3s` guided local-cluster setup command (initiative slice 1: host probe +
  report).

  `cat-factory k3s` probes the machine over a new injectable host shell-out seam (`HostShell`) for a
  reachable cluster / installed `k3d`/`kind`/`k3s`/`kubectl` / a running Docker, classifies the host
  (pure `classifyHost`), and reports what it found plus a recommended path — reuse the existing
  cluster, create a k3d or kind cluster (Docker, no root; selected by `--runtime`), or the guided
  (sudo) k3s path (which points at starting an already-installed k3s, or otherwise prints the install
  command — never run). The apiserver-contacting `kubectl` probes carry a `--request-timeout` and the
  `HostShell` has a watchdog, so a stale kubeconfig fails fast instead of hanging the probe. Mirrors
  the `init` command's pure-planner + IO-seam shape and is fully unit-tested with a scripted fake
  shell. Cluster provisioning, ServiceAccount/token minting, and wiring the `local-k3s` infra handler
  follow in later slices.

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
