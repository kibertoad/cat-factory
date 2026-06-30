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

To make the per-PR isolation real, the repo compose file is read checkout-free and **rewritten
into one project file** before `up`: every service's published host port is forced ephemeral (so
two concurrent per-PR stacks can't collide on a pinned host port — an additive `-f` overlay can't
strip the base's mapping), the probed service is guaranteed to publish its port, and references
this checkout-free backend can't honor — `build:` contexts, host bind mounts, relative `env_file`s,
and `privileged` services — are **refused up front** with a clear reason instead of silently
mis-mounting. An **auto-teardown TTL** is collected on the connect form (`ttlMinutes`, default
2h; `0` = never) so a forgotten preview env is swept off the host instead of leaking containers +
volumes. `testConnection` now probes the daemon (`compose ls`), not just the CLI, and every daemon
call is time-bounded so a wedged daemon can't hang a provision/status/teardown. Default project
names are disambiguated by block id so two workspaces sharing a repo name + PR number can't
collide, and `status` reads `ps -a` so a brief container recreate doesn't flip a healthy env to
`failed`.

The local facade (`@cat-factory/local-server`) registers it by reference, closing over the host
docker CLI, on the Docker-family runtimes only (Apple `container`, the plain Node service, and the
Cloudflare Worker have no host docker daemon, so they don't register it — the documented
runtime-bound asymmetry). The infrastructure picker (`@cat-factory/app`) surfaces it on the "Where
test environments run" axis with actionable "when to use this" guidance and a local-only caveat.

v1 supports self-contained image-based compose stacks (a service that builds from source, or that
needs host bind mounts / relative env files, needs a full checkout — a follow-up). No
backwards-compat concerns: this is a net-new opt-in backend.
