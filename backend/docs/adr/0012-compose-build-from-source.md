# ADR 0012: Docker Compose build-from-source support for local ephemeral environments

- **Status:** Accepted (implemented)
- **Date:** 2026-07-04
- **Context layer:** backend (`@cat-factory/integrations`, `@cat-factory/local-server`, `@cat-factory/contracts`)

## Context

The Docker Compose ephemeral-environment backend
(`backend/packages/integrations/src/modules/compose/`) is checkout-free / image-pull only: it
reads a repo's compose file with a single `RepoFiles.getFile` and hard-rejects any `build:`
directive, host bind mount, relative `env_file`, or `privileged: true`, because none of those
can resolve without the repo on disk and the stack runs on a shared host daemon.

That excludes a common real-world case — an application repo whose `docker-compose.yml` builds
its images from Dockerfiles and host-mounts init/seed scripts (e.g. a .NET + Angular + SQL
Server app). Autodetection makes it worse: it recognizes such a compose file at high confidence
but is content-blind, so it recommends `docker-compose` and the provision then fails.

## Decision

Add an opt-in `build` mode. When enabled, the provider clones the PR head into a per-project
working tree, writes the isolation-safe rewritten compose file beside the original inside that
checkout, and runs `docker compose build` + `up --wait`. Image mode and every host-safety
guarantee stay intact; the only relaxations are the three things a checkout makes valid
(`build:`, in-checkout relative binds, relative `env_file`). `privileged` and any
host-escaping reference stay refused in both modes.

Key mechanics:

- **Persisted, explicit `build` flag** (`ComposeEnvironmentConfig.build` /
  `ServiceProvisioning.composeBuild`) — the provider keys purely on this flag and never
  inspects file content to decide to build; autodetection only _recommends_ the flag.
- **One source of truth for the safety predicates** (`hasBuildDirective`, `bindMountSource`,
  `escapesCheckout`) shared by provisioning and autodetection.
- **A clone seam on `ComposeRuntime`** (`checkout` / `writeCheckoutFile`), implemented only in
  the local runtime (shallow git clone, token-in-URL), placed under the project dir so cleanup
  reaps it.
- **Rewrite inside the checkout**, run with `--project-directory` pointed at that directory so
  relative contexts/binds/env_files resolve as authored.
- **Split timeouts** — a longer budget for `compose build`, kept separate from the existing
  `up --wait` timeout.

## Rationale

- **Host-escape is the core safety line, applied uniformly.** Build mode rejects escaping
  sources for bind mounts, `env_file`s, the `build:` context, and top-level `secrets:`/`configs:`
  `file:` sources alike — only in-checkout relatives are allowed. Special-casing one reference
  kind and forgetting the others is exactly the hole a build-mode preview env would exploit.
- **`include:` and cross-file `extends: { file }` stay refused in both modes** — the daemon
  merges those files from disk at build/up time, bypassing this backend's single-file parse and
  its guards entirely, so a merged file could smuggle a privileged container or host bind past
  validation.
- **Runtime-bound asymmetry is deliberate.** Build registers only on the docker-family local
  runtime (compose is already a local-only feature), not Node-plain or the Worker — there is no
  local daemon on those facades.

## Consequences

- A private base image or sidecar still needs registry auth this backend does not provision;
  build mode only fixes building the app's own images.
- No PR-close/merge teardown webhook was added; environments still tear down via the TTL sweep,
  on-demand, or gate-close.
- Build mode is local-only (docker-family runtime); the Worker and plain-Node facades cannot use
  it.
- Image mode remains the default; the `build` flag is strictly additive.
