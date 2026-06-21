---
'@cat-factory/local-server': minor
'@cat-factory/node-server': minor
'@cat-factory/server': minor
'@cat-factory/worker': patch
---

Add a local-mode runtime facade (`@cat-factory/local-server`) so a developer can run
the whole product on their own machine. It is the Node.js facade
(`@cat-factory/node-server`: shared Hono app + Drizzle/Postgres + pg-boss) with two
local differentiators: agent jobs run as per-job local Docker/Podman containers (the
new `LocalDockerRunnerTransport` — the local analogue of the Worker's per-run
Cloudflare Container and an org's self-hosted runner pool, driven through the same
`RunnerTransport` port), and GitHub is reached via a personal access token (`GITHUB_PAT`)
instead of a GitHub App. `startLocal()` boots the service; `buildLocalContainer()` is
the composition root. The agent containers clone, push branches and open real PRs on
github.com with the PAT; pipelines run end to end locally.

To support this cleanly, `@cat-factory/node-server` gained composition seams used by
the local facade (all default to the existing Node behaviour): `buildNodeContainer`
now accepts an injected `resolveTransport`, `mintInstallationToken` and `githubClient`,
and `start()` accepts an injected `buildContainer` and a `host` bind address (else
`HOST` from the env, else all interfaces — so a deployment can keep the service off the
LAN). It also re-exports `createApp`. The local facade runs the shared cross-runtime
conformance suite (with a fake agent executor) so it can't drift from the Node and
Cloudflare facades.

The runtime-neutral fetch-based GitHub client and the CI / merge / mergeability
providers (`FetchGitHubClient`, `GitHubCiStatusProvider`, `GitHubMergeabilityProvider`,
`GitHubPullRequestMerger`) move from the Cloudflare runtime into `@cat-factory/server`
(re-exported from the Worker for existing imports — no behaviour change), so every
facade can gate on real CI and merge for real. `FetchGitHubClient` now accepts any
`AppTokenSource` (the App registry or a static PAT). Local mode wires these from a
PAT-backed client, so a local pipeline gates on real GitHub Actions CI and merges the
PR for real. The Node facade now also wires these gates when a GitHub App is configured
— it builds a `FetchGitHubClient` from its own shared App registry — so a stock
Node-with-App deployment gates on real CI and merges for real too (parity with the
Worker; previously only local mode did).

Local-mode robustness: the Docker transport is now constructed lazily, so the service
boots (to serve the board + inline kinds) even without `LOCAL_HARNESS_IMAGE` — only
repo-operating kinds then fail, loudly. On boot it reaps per-job containers orphaned by
a previous crash, and on re-dispatch it removes any lingering container for the same job
id before starting a fresh one. The `linkRepo` helper clears a stale installation row
for the workspace before upserting (robust against the `github_installations`
workspace-unique index), and local mode warns when the auth gate is left open on a
network-reachable bind.
