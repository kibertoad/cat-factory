---
'@cat-factory/kernel': minor
'@cat-factory/contracts': minor
'@cat-factory/integrations': minor
'@cat-factory/server': minor
'@cat-factory/orchestration': minor
'@cat-factory/node-server': patch
'@cat-factory/worker': patch
---

Environment provider repo-config lifecycle: validate + bootstrap (+ agent-repair seam)

Adds optional `EnvironmentProvider` capabilities so a native adapter (e.g. a future Kargo
adapter) can manage its config file inside the deployed repo:

- `validateRepo` — mechanical repo-config validation, run on-demand
  (`POST /environments/connection/validate-repo`) and as a provision pre-flight gate that
  fails synchronously before `provider.provision()` instead of as an async failed environment.
- `describeBootstrapInputs` + `bootstrapProviderConfiguration` — mechanically generate the
  config file from UI-collected variables; the engine commits it (idempotent; optional PR) and
  re-validates (`POST /environments/connection/bootstrap-repo`).
- `describeRepairAgent` — agent-repair prompt + dispatch seam (the live engine dispatch is
  scaffolded but not yet wired; see `backend/docs/env-lifecycle.md`).

All repo I/O flows through the existing VCS-neutral `RepoFiles` abstraction, so the provider
never sees a VCS host or token (GitHub today, GitLab later). The provider descriptor now
carries `supportsRepoValidation` / `supportsRepoBootstrap` / `bootstrapInputs`. The generic
`HttpEnvironmentProvider` implements none of these, so manifest-driven providers are unchanged.
