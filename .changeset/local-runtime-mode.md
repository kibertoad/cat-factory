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
and `start()` accepts an injected `buildContainer`. It also re-exports `createApp`. The
local facade runs the shared cross-runtime conformance suite (with a fake agent
executor) so it can't drift from the Node and Cloudflare facades.

The runtime-neutral fetch-based GitHub client and the CI / merge / mergeability
providers (`FetchGitHubClient`, `GitHubCiStatusProvider`, `GitHubMergeabilityProvider`,
`GitHubPullRequestMerger`) move from the Cloudflare runtime into `@cat-factory/server`
(re-exported from the Worker for existing imports — no behaviour change), so every
facade can gate on real CI and merge for real. `FetchGitHubClient` now accepts any
`AppTokenSource` (the App registry or a static PAT). Local mode wires these from a
PAT-backed client, so a local pipeline gates on real GitHub Actions CI and merges the
PR for real.
