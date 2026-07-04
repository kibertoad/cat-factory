---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/integrations': minor
'@cat-factory/local-server': minor
---

Docker Compose ephemeral envs: opt-in build-from-source mode.

The Docker Compose environment backend was checkout-free / image-pull only and hard-rejected
`build:`, host bind mounts, relative `env_file`, and `privileged`, so an app repo that builds
its own images (e.g. a .NET + Angular + SQL Server stack) could not become a per-PR preview env.

A new opt-in `build` mode (workspace handler `providerConfig.build`, mirrored advisory
`ServiceProvisioning.composeBuild`) clones the PR head into a per-project working tree, writes
the isolation-safe rewritten compose beside the original inside the checkout, and runs
`docker compose build` + `up --wait`. In build mode `build:`, in-checkout relative bind mounts,
and relative `env_file`s are honored; `privileged: true` and **host-escaping** bind mounts
(absolute / `~` / `../`-escape) stay refused. Image mode is unchanged and remains the default.

The `ComposeRuntime` seam gains optional `checkout`/`writeCheckoutFile` (implemented in the local
facade via a shallow, token-authenticated git clone); `ProvisionEnvironmentRequest` gains a
`clone` target resolved on the synchronous provision path (reusing the deploy clone-target seam).
Build mode registers only on the docker-family local runtime — the documented runtime-bound
exception. Build timeout is separate from the health-wait bound (`buildTimeoutMinutes`).

Auto-detection is now content-aware: a compose stack that declares `build:` is detected and
recommended in build-from-source mode (previously it was recommended blindly and then failed at
provision time).
