---
'@cat-factory/local-server': minor
'@cat-factory/node-server': minor
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

To support this cleanly, `@cat-factory/node-server` gained two composition seams used
by the local facade (both default to the existing Node behaviour): `buildNodeContainer`
now accepts an injected `resolveTransport` and `mintInstallationToken`, and `start()`
accepts an injected `buildContainer`. It also re-exports `createApp`. The local facade
runs the shared cross-runtime conformance suite (with a fake agent executor) so it
can't drift from the Node and Cloudflare facades.
