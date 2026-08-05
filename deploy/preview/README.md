# deploy/preview: per-PR test environments for cat-factory itself

The **bootstrap configuration for a cat-factory test environment**: everything needed to stand
up the whole product (API, board SPA, database) from an arbitrary PR branch, so a change can
be exercised against a running system instead of only against unit tests.

It exists so that **cat-factory can be developed with cat-factory**: when a pipeline runs on
this repository, its `deployer` step stands one of these up and its `tester` / `human-test`
steps run against the live URL. Everything here is equally usable by hand: `docker compose up`
in one case, a PR push in the other.

There are two tracks, because the orchestrator's own runtime decides what it can stand up:

| Track                         | Use it when cat-factory runs…                                         | Provision type   | What comes up                                                            |
| ----------------------------- | --------------------------------------------------------------------- | ---------------- | ------------------------------------------------------------------------ |
| [`compose/`](./compose)       | **locally** (`@cat-factory/local-server`, or Node with a Docker host) | `docker-compose` | Postgres + the Node facade + the SPA, one origin, built from the PR head |
| [`cloudflare/`](./cloudflare) | **on Cloudflare** (`@cat-factory/worker`)                             | `cloudflare`     | A per-PR Worker + its own D1 databases + a Pages preview of the SPA      |

Wiring either one into a board (frames, handler, provisioning config, pipeline) is
[`docs/internal/dogfooding.md`](../../docs/internal/dogfooding.md). This README is about the stacks themselves.

## Why these two, and not the others

The choice is constrained more than it looks: the environment is stood up **by the orchestrator's
runtime**, so "what can this facade actually execute?" comes before "what would be nicest?".

| Option                                                      | Verdict                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Docker Compose** (chosen: local)                          | Zero infrastructure beyond the Docker daemon a local deployment already needs for its agent containers, and the environment backend already knows how to build one from a PR head, isolate it per PR and reap it. Local-only by construction: `local-docker` needs a daemon, which the Worker facade does not have.                                                                                                                                                                                                                    |
| **Cloudflare per-PR Worker** (chosen: Cloudflare)           | The only option that tests what actually ships on Cloudflare: real D1, real Durable Objects, real Workflows, real crons. Driven entirely over HTTPS (the GitHub Deployments API), so the Worker facade can provision it with no container, no cluster and no filesystem.                                                                                                                                                                                                                                                               |
| **k3s / k3d** (documented, not shipped here)                | cat-factory supports it fully ([`local-k3s-environments.md`](../../backend/docs/local-k3s-environments.md), [`per-service-provisioning.md`](../../backend/docs/per-service-provisioning.md)) and it is the right answer for an org already running a cluster. It is a worse **default**: a cluster to run, per-PR images to build and push to a registry, and an ingress to reach; all to run the same three containers compose runs for free. Nothing here blocks it: add a kustomize overlay and point a `kubernetes` handler at it. |
| **Managed Kubernetes / EKS**                                | Same shape as k3s with more setup and real cost. Worth it when the preview must live somewhere a whole team can reach; overkill for the change-by-change loop this is for.                                                                                                                                                                                                                                                                                                                                                             |
| **`infraless` (no environment)**                            | What you get today if you configure nothing: unit and conformance tests still run in the container, but nothing exercises the assembled product. That is the gap this directory closes.                                                                                                                                                                                                                                                                                                                                                |
| **A long-lived shared staging deployment**                  | Cheapest to build, worst to use: concurrent PRs share one schema, so one PR's migration breaks another's run, and a failed test tells you nothing about which change caused it. Per-PR isolation is the whole point.                                                                                                                                                                                                                                                                                                                   |
| **`wrangler versions upload` (preview URLs)** on Cloudflare | Attractive, no resources to create, immutable per-version URLs, but every version shares the parent Worker's bindings, so all PRs would share one D1. Same isolation failure as shared staging, so it lost to the per-PR Worker.                                                                                                                                                                                                                                                                                                       |

## The compose track (local)

[`compose/docker-compose.yml`](./compose/docker-compose.yml) stands up three containers:

- **postgres**: the datastore, on a per-project volume that is destroyed with the environment.
- **backend**: the Node facade, built from `deploy/node/Dockerfile`, i.e. the _same image
  definition the real Node deployment ships_. It migrates the database on boot.
- **web**: Caddy serving the statically generated SPA and reverse-proxying the API, so both
  halves share **one origin** ([`compose/Caddyfile`](./compose/Caddyfile)).

Single-origin is load-bearing, not tidiness. The SPA is `ssr: false`, so its API base is baked
in when it is built, while a preview stack's host port is only assigned at `up` time: an
absolute API base could not be known in time. Serving both halves on one origin lets the SPA
use a relative API base that is correct on whatever port the stack lands on (and removes CORS
from the picture). It is why `@cat-factory/app` treats an empty `apiBase` as "same origin" when
deriving the WebSocket URL.

By hand:

```sh
cd deploy/preview/compose
docker compose up --build --wait     # first build is slow: it installs and builds the workspace
docker compose down -v               # containers + the database volume
```

Then open <http://localhost:8080>. The stack runs with **no authentication**
(`TESTING_NO_AUTH=true` in a non-production `ENVIRONMENT`), so the board opens straight up and
a tester agent can drive the REST API with no credential plumbing. Its crypto secrets are
throwaway values committed in the compose file: nothing of value is ever sealed under them, and
the stack is destroyed with the environment.

**What it does NOT include:** LLM provider keys, a GitHub App, and a runner backend. A preview
exercises the API, the board, real-time push, persistence and migrations, not agent runs
against real models. Set the corresponding environment variables on the `backend` service if
you need a preview that can run agents.

Through cat-factory, the environment backend rewrites this file before running it: host ports
are forced ephemeral so concurrent per-PR stacks never collide, and `web`'s port is published
and read back to form the environment URL. `include:`, cross-file `extends`, and `privileged`
are refused outright by the backend, in every mode. Bind mounts and `env_file` are avoided too:
build-from-source mode would accept in-checkout relative ones, but this file must also stay
runnable in image mode and by hand, where they resolve against a directory that is not there.

## The cloudflare track

[`.github/workflows/preview-env.yml`](../../.github/workflows/preview-env.yml) deploys, per PR:

- a Worker named `cat-factory-pr-<n>` from
  [`cloudflare/wrangler.preview.template.toml`](./cloudflare/wrangler.preview.template.toml),
- its **own** three D1 databases, migrated before the Worker rolls out,
- optionally the SPA to a Pages preview branch, pointed at that Worker.

The control plane is the **GitHub Deployments API**: cat-factory POSTs a deployment, GitHub
fires the `deployment` event, the workflow builds; cat-factory reads that deployment's statuses
to know when it is live; cat-factory posts an `inactive` status and the workflow's teardown job
deletes the Worker and the databases. cat-factory therefore needs nothing but outbound HTTPS to
`api.github.com`, no management service to host, nothing that assumes a filesystem, which is
what lets the Cloudflare facade provision one at all.

This is a **built-in backend** (`Cloudflare Workers`, provision type `cloudflare`), not a
manifest you paste. That matters beyond convenience: a manifest had to pin one `owner/repo` and
one subdomain into hand-substituted JSON, could not read a real readiness signal (the statuses
endpoint returns an array the generic response mapping cannot extract a URL from, so it had to
assert `ready` the moment the deployment record existed), and rendered a run with no open pull
request as an environment literally named `pr-`. The built-in backend resolves the repository
per run from the service frame, reports `provisioning` until the workflow actually succeeds, and
refuses a run with no pull request with a message that says so.

The `pull_request` trigger is scoped to the preview setup's own files, so an ordinary PR does
not build one; a `deployment` event for a commit that has already been built short-circuits
instead of rebuilding, so the two paths compose without waste.

### One-time setup

Create a GitHub environment named `preview` (Settings → Environments) and give it:

| Kind   | Name                             | Value                                                                                     |
| ------ | -------------------------------- | ----------------------------------------------------------------------------------------- |
| secret | `CLOUDFLARE_API_TOKEN`           | scoped to Workers + D1 + Pages **edit** on the preview account. Not the production token. |
| secret | `CLOUDFLARE_ACCOUNT_ID`          | the account the previews live in                                                          |
| secret | `PREVIEW_AUTH_SESSION_SECRET`    | any 32+ character string                                                                  |
| secret | `PREVIEW_ENCRYPTION_KEY`         | base64, 32 bytes (`openssl rand -base64 32`)                                              |
| secret | `PREVIEW_HARNESS_SHARED_SECRET`  | any 16+ character string                                                                  |
| secret | `PREVIEW_GITHUB_APP_PRIVATE_KEY` | a **throwaway** App's key (`openssl genrsa 2048` also works: see below)                   |
| var    | `CLOUDFLARE_WORKERS_SUBDOMAIN`   | your `*.workers.dev` subdomain: the preview URL is derived from it                        |
| var    | `PREVIEW_GITHUB_APP_ID`          | the throwaway App's id                                                                    |
| var    | `PREVIEW_PAGES_PROJECT`          | a Pages project for the SPA previews. Leave unset to deploy the API only.                 |

The App key is required because the Worker refuses to assemble its agent executor without one
and serves its "misconfigured" app instead: a preview that answered every request with a
config error would be useless. It is **not** used to reach GitHub in a preview, so a throwaway
App (or a self-signed key) is the right thing to put there. Never the production App's key: a
preview runs unreviewed branch code.

Then, on cat-factory: fill in the built-in **Cloudflare Workers** handler (subdomain + token)
and set the backend service frame's provisioning type to `cloudflare`; see
[`docs/internal/dogfooding.md`](../../docs/internal/dogfooding.md).

### Cost and limits

Each open PR holds one Worker, three D1 databases and a container application, all of which the
teardown job removes. Environments carry a 4-hour TTL in the manifest, so cat-factory reaps
them even if a PR is abandoned mid-run. A preview never touches production resources: different
Worker, different databases, different (throwaway) App.

### Security

Both triggers refuse fork PRs, so only branches of this repository are ever deployed, and the
`preview` environment's credentials are preview-only by construction. Bear in mind that a
same-repo PR can edit the workflow itself (that is true of any CI-secret setup): keep the
preview account separate from the production one, and use the environment's protection rules if
you want a human approval in front of every preview deploy.
