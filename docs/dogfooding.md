# Developing cat-factory with cat-factory

How to point a cat-factory workspace at **this repository** so its pipelines can implement,
review, deploy and test cat-factory itself, and, in particular, how a run gets a **live test
environment** to check its own work against instead of stopping at unit tests.

The environment stacks themselves live in [`deploy/preview/`](../deploy/preview) and are
documented there (including which options were considered and why these two won). This page is
the **board wiring**: the frames, the handler, the provisioning config, the pipeline, and the
things that bite.

## What you get

A run on a task in this repo ends up doing, in one pipeline:

1. `coder`: implements on a branch and opens a PR (already worked before any of this).
2. `deployer`: stands up a **per-PR environment running that branch's code**: the compose
   stack on a local deployment, a per-PR Cloudflare Worker on the Worker facade.
3. `tester-api` / `human-test`: exercises the running product at that environment's URL.
4. `ci` → `merger`: the usual gates on the real PR.

Steps 1, 3 and 4 needed no new configuration. Step 2 is what `deploy/preview/` adds.

## Pick a track

The orchestrator's own runtime decides what it can stand up, so this is not really a preference:

| cat-factory runs on…                                               | Track                                      | Provision type          |
| ------------------------------------------------------------------ | ------------------------------------------ | ----------------------- |
| `@cat-factory/local-server` (or Node with a reachable Docker host) | [compose](../deploy/preview/compose)       | `docker-compose`        |
| `@cat-factory/worker` (Cloudflare)                                 | [cloudflare](../deploy/preview/cloudflare) | `cloudflare` (built in) |

`local-docker` needs a Docker daemon, which the Worker facade does not have; the Cloudflare
track is driven entirely over HTTPS, so it works from either. If you run cat-factory locally but
want previews that outlive your laptop, the Cloudflare track works there too.

## 1. Onboard the repository

Connect the VCS integration and onboard `cat-factory` as a **service** frame (repo role
`service`). Repo→block linkage is what execution resolves the target repo from, so the frame
must be the block the repo row points at.

**This is a monorepo, and a repo links to exactly ONE block.** Model cat-factory as a single
service frame covering both halves rather than a `service` + `frontend` pair: the frontend has
no repo of its own to link, and both preview stacks serve the SPA and the API together anyway
(one origin in the compose track, the Pages preview beside the Worker in the Cloudflare one).
Modules under that frame (kernel, orchestration, server, the runtimes, the frontend layer) are
sub-frames, which is what the `blueprints` agent will populate for you on its first run.

## 2. Configure the environment handler (the "how")

The workspace owns the engine and its connection. Infrastructure → Test environments.

### Compose track

Add a `docker-compose` handler on the **`local-docker`** engine, with this `providerConfig`:

| Field                 | Value                                       | Why                                                                                 |
| --------------------- | ------------------------------------------- | ----------------------------------------------------------------------------------- |
| `composePath`         | `deploy/preview/compose/docker-compose.yml` | read from the PR head                                                               |
| `service`             | `web`                                       | the service whose port becomes the environment URL (Caddy: SPA **and** API)         |
| `port`                | `8080`                                      | its container port                                                                  |
| `build`               | `true`                                      | **load-bearing**: the stack builds cat-factory from the PR head rather than pulling |
| `buildTimeoutMinutes` | `45`                                        | the default 15 is not enough to install and build this workspace from cold          |

`build` lives on the **handler**, not the frame: the frame's `composeBuild` is advisory, and the
provider keys on this one. Without it the provider refuses the file (a `build:` directive cannot
resolve with no checkout).

Local deployments also widen the environment-URL policy by default
(`ENVIRONMENTS_ALLOW_HTTP_URLS` plus a loopback allow-list), which is what lets
`http://localhost:<ephemeral-port>` be accepted as an environment URL. On a plain Node
deployment set those explicitly: see
[`local-k3s-environments.md`](../backend/docs/local-k3s-environments.md) for the same knobs.

### Cloudflare track

**Cloudflare Workers preview** is a built-in handler, so there is no manifest to paste. In
Infrastructure → Test environments, fill in its section:

| Field                 | Value                                                                                  |
| --------------------- | -------------------------------------------------------------------------------------- |
| workers.dev subdomain | your account's subdomain label: the preview URL derives from it                        |
| VCS API token         | a fine-grained token on this repo with **Deployments: read & write**, and nothing else |
| Workflow repository   | leave blank; each service frame's own repo is used                                     |
| Advanced              | leave blank unless you renamed things in the workflow                                  |

The two name templates under **Advanced** are the contract with
[`.github/workflows/preview-env.yml`](../.github/workflows/preview-env.yml): cat-factory derives
the environment name and the Worker URL from them, and the workflow names its resources the same
way. Blank means the reference workflow's naming (`pr-<n>` / `cat-factory-pr-<n>`), so leave them
alone unless you have changed the workflow too.

Complete the one-time GitHub `preview` environment setup in
[`deploy/preview/README.md`](../deploy/preview/README.md) first, or the deployments will fire a
workflow that has no credentials to build with. **Test connection** verifies the token can reach
the repository, and the handler pre-flights that the repo actually carries a preview workflow
before a run waits on a build that was never going to happen.

## 3. Declare the frame's provisioning (the "what + where")

On the cat-factory service frame, inspector → provisioning:

```jsonc
// compose track
{ "type": "docker-compose", "composePath": "deploy/preview/compose/docker-compose.yml", "composeBuild": true }

// cloudflare track - the type is the whole declaration; the per-PR recipe lives in the repo's
// own preview workflow, so there is no path or manifest id for the service to name.
{ "type": "cloudflare" }
```

The frame declares the intent; the handler above supplies the engine. Both are needed: a frame
with no declared type falls through to the legacy single-connection path, and a declared type
with no matching handler is refused at run start rather than dead-ending inside the tester.

## 4. Declare the validation checks

Per-frame validation runs **in the coding container before the PR opens**, so a red build never
reaches a reviewer. On the frame's validation panel:

| Check   | Command                          |
| ------- | -------------------------------- |
| install | `pnpm install --frozen-lockfile` |
| lint    | `pnpm lint`                      |
| build   | `pnpm build`                     |
| test    | `pnpm test:run`                  |

Leave `maxAttempts` at 3. These are the same commands CI runs, which is the point: the agent
gets the failure and a repair round while it still has the checkout, instead of finding out from
a red PR ten minutes later.

## 5. Pick a pipeline

Every built-in pipeline that runs a `tester-*` or `human-test` step already runs a `deployer`
before it, so no custom pipeline is needed: any rung of the build ladder works as-is: "Standard
build" (`pl_build`, the default), "Simple build" (`pl_simple`) or "Adaptive build" (`pl_full`). The
deployer is a no-op for a frame that declares no environment, which is why it can sit in every
pipeline; once you have completed steps 2 and 3 it starts standing one up.

## What a preview does and does not cover

**Covered:** the HTTP API, the board SPA, real-time push over WebSocket, persistence and
migrations, auth-off request flows, and (on the Cloudflare track) that the Worker actually
boots on workerd with real D1, Durable Objects, Workflows and crons. That last one is the
failure class unit tests structurally cannot catch.

**Not covered:** agent runs against real models. Neither preview carries LLM provider keys, a
usable GitHub App, or a runner backend, so a pipeline started _inside_ a preview will not get
far. That is deliberate: a preview must come up unattended with no credential plumbing and
nothing worth stealing. Add the provider variables to the compose `backend` service (or the
preview Worker's secrets) if you specifically want to test agent behaviour end to end.

## Gotchas

- **The first compose build is slow** (installing and building the whole workspace, twice over:
  the backend image and the SPA image). Budget ~15–30 minutes cold, much less warm. This is why
  `buildTimeoutMinutes` is raised above its default.
- **Concurrent previews are isolated but not free.** Each compose environment is its own project
  with its own volume and ephemeral ports; each Cloudflare environment is its own Worker plus
  three D1 databases. Both are reaped by teardown and by the TTL sweep, but a machine (or an
  account) running many at once will feel it.
- **The Cloudflare environment is registered before it is live.** The generic HTTP backend
  settles a provision synchronously, so cat-factory records the (deterministic) preview URL
  immediately while the workflow is still building. The workflow's `pull_request` trigger is
  what normally closes that window: the environment is built when the branch is pushed, minutes
  before a run reaches its deployer step. If a tester ever does race it, the deployment statuses
  on the PR are the record of what happened.
- **A preview runs unreviewed branch code with whatever credentials you give it.** Keep the
  preview Cloudflare account and GitHub App separate from production; see the security note in
  [`deploy/preview/README.md`](../deploy/preview/README.md).

## Editing `deploy/preview`: three constraints that bite

- **The compose file must stay free of `include:` / cross-file `extends` / `privileged` and of
  bind mounts / `env_file`**, so it stays runnable by hand.
- **The SPA there is built with an EMPTY `apiBase`**, because a preview's host port is only
  assigned at `up` time and same-origin is the only workable topology.
- **The workflow's per-PR resource NAMES are a contract with
  `cloudflareEnvironmentConfigSchema`'s two name templates**: rename in one place, rename in
  both.

## Related

- [`deploy/preview/README.md`](../deploy/preview/README.md): the stacks, and the options weighed.
- [`backend/docs/per-service-provisioning.md`](../backend/docs/per-service-provisioning.md): the
  provision-type / handler model this page configures.
- [`backend/docs/local-k3s-environments.md`](../backend/docs/local-k3s-environments.md): the
  Kubernetes alternative, if you already run a cluster.
- [`backend/internal/e2e/README.md`](../backend/internal/e2e/README.md): the assembled-product
  test suite, which covers the same surfaces deterministically with every external dependency
  faked. Previews complement it; they do not replace it.
