---
'@cat-factory/integrations': minor
'@cat-factory/local-server': minor
'@cat-factory/app': minor
---

Add a Docker Compose ephemeral-environment backend (the Checkbox-style preview-env mechanic).

`composeEnvironmentBackend(runtime)` (new in `@cat-factory/integrations`) is an
`EnvironmentProvider` that stands the PR repo's own `docker-compose.yml` up on a local Docker
daemon under a per-PR `COMPOSE_PROJECT_NAME`, publishes the configured web service's port to an
ephemeral host port, returns `http://localhost:<port>` for the Tester/`deployer` flow, and tears
the project down on TTL. It rides the contract's generic environment-backend manifest member (no
new config variant, no migration): the flat config lives in the stored manifest's `providerConfig`,
written by the descriptor-driven connect form.

The local facade (`@cat-factory/local-server`) registers it by reference, closing over the host
docker CLI, on the Docker-family runtimes only (Apple `container` and the Cloudflare Worker have no
host daemon, so they don't register it — the documented runtime-bound asymmetry). The
infrastructure picker (`@cat-factory/app`) surfaces it on the "Where test environments run" axis
with actionable "when to use this" guidance and a local-only caveat.

v1 supports image-based compose stacks (a service that builds from source needs a full checkout,
a follow-up). No backwards-compat concerns: this is a net-new opt-in backend.
