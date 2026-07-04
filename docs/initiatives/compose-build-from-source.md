# Initiative: Docker Compose build-from-source preview envs

**Status:** slices 0–4 landed (build mode usable end-to-end on the local facade) · **Owner:** environments · **Started:** 2026-07-04

> Durable source of truth for a multi-PR initiative. Read this first before picking up the
> next slice; update the checklist at the end of each PR.

## Goal & rationale

The Docker Compose ephemeral-environment backend
(`backend/packages/integrations/src/modules/compose/`) is **checkout-free / image-pull only**.
It reads the repo's compose file with a single `RepoFiles.getFile` (no working tree) and
**hard-rejects** any `build:` directive, host bind mount, relative `env_file`, and
`privileged: true` (`collectUnsupportedComposeRefs`), because none of those can resolve without
the repo on disk and the stack runs on a shared host daemon.

That excludes the common real-world case: an application repo (the motivating example is a
.NET + Angular + SQL Server app) whose `docker-compose.yml` **builds its images from
Dockerfiles** and host-mounts SQL init/seed scripts. Autodetection makes it worse — it
recognizes the compose file at **high confidence** but is content-blind, so it recommends
`docker-compose` and the provision then fails.

The fix: an **opt-in `build` mode**. When enabled, the provider clones the PR head into a
per-project working tree, writes the isolation-safe rewritten compose beside the original inside
the checkout, and runs `docker compose build` + `up --wait`. Image mode and every host-safety
guarantee stay intact; the only relaxations are the three things a checkout makes valid
(`build:`, in-checkout relative binds, relative `env_file`). `privileged` and **host-escaping**
binds stay refused.

## Target pattern (the reference implementation = Slice 1 pilot)

The mode-aware pure logic + the `ComposeRuntime.checkout` vertical is the shape every later
slice conforms to:

1. **Persisted, explicit `build` flag** — `providerConfig.build` → `ComposeEnvironmentConfig.build`;
   `ServiceProvisioning.composeBuild` (contracts). The provider keys purely on the persisted flag;
   it NEVER inspects file content to decide to build (deterministic + safe). Autodetection only
   _recommends_ the flag.
2. **One source of truth for the reference predicates** — export `hasBuildDirective`,
   `bindMountSource`, `escapesCheckout` from `compose-environment.logic.ts`; both provisioning
   (`collectUnsupportedComposeRefs(doc, {build})`) and autodetection (`findCompose`) consume them.
   Never re-implement a predicate.
3. **Clone seam on the existing `ComposeRuntime`** — optional `checkout(project, {cloneUrl, ref,
token})` + `writeCheckoutFile(project, relPath, content)`, mirroring the optional
   `cleanupProject?`. Real impl only in `runtimes/local/src/compose.ts` (shallow git clone,
   token-in-URL à la `backend/internal/deploy-harness/src/git.ts`), placed UNDER
   `projectDir(project)` so `cleanupProject` reaps it. Integrations stays `node:*`-free.
4. **Rewrite inside the checkout** — write the rewritten compose as a sibling of the original at
   `<checkout>/<dirname(composePath)>/cat-factory.compose.yaml`, run with
   `--project-directory <that dir> -f <that file>` so relative contexts/binds/env_files resolve
   as authored. `neutralizeHostPorts` + `ensureServicePublishes` still run in both modes.
5. **Clone target on the sync path** — resolve+attach `clone?: DeployCloneTarget` in
   `EnvironmentProvisioningService.buildProvisionRequest` via the existing
   `resolveDeployCloneTarget` (today only invoked on the async k8s path); add `clone?` to the
   kernel `ProvisionEnvironmentRequest`. Local mode inherits Node's PAT-backed resolver.
6. **Split timeouts** — a new `BUILD_TIMEOUT_MS` (default ~900s, `buildTimeoutMinutes` override)
   for `compose build`, separate from the existing 300s `up --wait`.

## Per-slice checklist

| #   | Slice                                                                                                                                                          | Status  | PR     |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | ------ |
| 0   | Tracker doc                                                                                                                                                    | ✅ done | (this) |
| 1   | **PILOT**: contracts flag + shared mode-aware predicates + `ComposeRuntime.checkout` (local impl) + `req.clone` sync seam + provider build branch + unit tests | ✅ done |        |
| 2   | Content-aware autodetection (`findCompose`/`composeRecommendation` set `composeBuild`)                                                                         | ✅ done |        |
| 3   | UI: `build` describeConfig field (renders in the connect form) + i18n parity (7 locales)                                                                       | ✅ done |        |
| 4   | Conformance (build-mode config round-trip + `describeConfig` build field, both facades) + docs                                                                 | ✅ done |        |

## Conventions / gotchas carried between iterations

- **Host-escape is the core safety line — apply it to EVERY path-bearing reference, uniformly.**
  Build mode rejects escaping sources via `escapesCheckout` for bind mounts, `env_file`s, the
  `build:` context, and top-level `secrets:`/`configs:` `file:` sources alike; only in-checkout
  relatives are allowed. `escapesCheckout` covers absolute / `~` / drive / UNC-or-backslash roots,
  `../`-above-root (including a separator-buried `a/../../b`), and any unresolved `${VAR}`/`$VAR`
  (it expands to an arbitrary host path at runtime). `bindMountSource` treats any short-form source
  containing a path separator as a host bind (a named volume never has one), so a `sub/../../etc`
  escape can't masquerade as a named volume. Do NOT special-case one reference kind and forget the
  others — that inconsistency is exactly what a build-mode preview env would exploit.
- **`include:` and cross-file `extends: { file }` are refused in BOTH modes.** The daemon merges
  those referenced files from disk at build/up time, so their services never pass through this
  backend's single-file parse (or `neutralizeHostPorts` / `ensureServicePublishes`) — a merged file
  would smuggle a privileged container, host bind, or pinned host port past every guard. Refuse them
  rather than trying to recursively resolve-and-validate.
- **Project-directory.** The rewritten file must sit beside the original inside the checkout and
  `--project-directory` (or the first `-f`) must point at that dir, or relative build contexts /
  mounts / env_files break.
- **Sync clone seam is a LAZY thunk.** `resolveDeployCloneTarget` was async-path-only; `req.clone`
  threads it through `buildProvisionRequest` as a memoized thunk so ONLY the build-mode provider
  that needs a working tree mints a token (image-mode / custom / k8s-sync provisions don't).
  Forgetting to wire it yields a null clone and a hard fail even with a PAT wired.
- **Private-image registry auth stays UNMODELED.** Build mode fixes building the app's OWN images;
  a private base image / sidecar still needs `docker login`, which this backend does not
  provision. Out of scope — call it out to the user.
- **SQL Server realism.** ~2GB RAM per stack; `--wait` relies on the stack's healthchecks or the
  port probe races an un-ready DB; init/seed one-shots must `exit 0` (`classifyComposePs` already
  tolerates that). No code change — lives in the compose file.
- **Timeouts stay separate.** A slow build must not consume the 300s `up --wait` budget.
- **Runtime-bound asymmetry is intentional.** Build registers ONLY on the docker-family local
  runtime (`runtimes/local/src/container.ts`); never Node-plain / Worker. This is the documented
  exception to "keep the runtimes symmetric" (compose is already local-only).
- **Pre-1.0 = no back-compat.** Image mode stays the default; the `build` flag is additive.

## Out of scope

Private-registry auth for build-mode base images (gap 8); a PR-close/merge teardown webhook
(gap 7 — envs still teardown via the TTL sweep / on-demand / gate-close); build mode on the
Worker or plain-Node facades (no local daemon).

The compose config (service / port / image source) surfaces through the descriptor-driven
provider connect form (`describeConfig` → `ProviderConnectionTab.vue`); the per-type
`InfraHandlersConfigurator` keeps its connection-less info block (docker-compose is served by the
runtime's local Docker), now pointing at the service's environment settings. A dedicated per-type
compose form there remains an optional follow-up.
