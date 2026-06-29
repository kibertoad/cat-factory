---
'@cat-factory/cli': patch
---

Polish the scaffolded local deployment: `local/.env` now carries commented container→host
reachability + security hints (the per-runtime host alias, the native-Linux-Docker
`add-host-gateway`, the `AUTH_DEV_OPEN` lockdown note), the `.env.example` files mirror the
chosen port/db/api-base instead of hardcoding `8787`, the generated README warns when `db:up`
needs a non-docker runtime (Podman/Apple), and a `git init` nudge is printed for a fresh target
dir. GitLab is now documented as a first-class local-mode provider (it gates CI + merges for real
via `@cat-factory/gitlab`).
