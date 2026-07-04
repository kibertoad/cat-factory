---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/integrations': minor
'@cat-factory/local-server': minor
'@cat-factory/app': patch
---

Docker Compose ephemeral envs: opt-in build-from-source mode.

The Docker Compose environment backend was checkout-free / image-pull only and hard-rejected
`build:`, host bind mounts, relative `env_file`, and `privileged`, so an app repo that builds
its own images (e.g. a .NET + Angular + SQL Server stack) could not become a per-PR preview env.

A new opt-in `build` mode (workspace handler `providerConfig.build`, mirrored advisory
`ServiceProvisioning.composeBuild`) clones the PR head into a per-project working tree, writes
the isolation-safe rewritten compose beside the original inside the checkout, and runs
`docker compose build` + `up --wait`. In build mode `build:`, in-checkout relative bind mounts,
and relative `env_file`s are honored. Image mode is unchanged and remains the default.

Host-escape refusal is uniform across EVERY path-bearing reference, not just bind mounts: bind
sources, `env_file`s, the `build:` context, and top-level `secrets:`/`configs:` `file:` sources are
all run through `escapesCheckout`, which now also catches UNC/backslash-absolute paths, a
separator-buried `../` source (`sub/../../../etc`, previously mis-read as a named volume), and an
unresolved `${VAR}` interpolation (expands to an arbitrary host path at runtime). `include:` and
cross-file `extends: { file }` are refused outright in both modes — the daemon merges those files
from disk, so their services would otherwise slip a privileged container / host bind / pinned port
past the parse-based guard. `privileged: true` stays refused.

The `ComposeRuntime` seam gains optional `checkout`/`writeCheckoutFile` (implemented in the local
facade via a shallow, token-authenticated git clone); `ProvisionEnvironmentRequest` gains a LAZY
`clone` resolver (a thunk) invoked only by the build-mode provider that actually needs a working
tree — so image-mode compose / custom / k8s-sync provisions no longer mint a short-lived VCS token
they never use (reusing the deploy clone-target seam, memoized so one provision never mints twice).
Build mode registers only on the docker-family local runtime — the documented runtime-bound
exception. Build timeout is separate from the health-wait bound (`buildTimeoutMinutes`).

Auto-detection is now content-aware: a compose stack that declares `build:` is detected and
recommended in build-from-source mode (previously it was recommended blindly and then failed at
provision time).

The compose environment connect form gains an "Image source" selector (pull pre-built vs build
from source) and a build-timeout field; the misleading "image-based stacks only" copy is removed.
