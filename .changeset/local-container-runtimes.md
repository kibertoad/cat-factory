---
'@cat-factory/local-server': minor
'@cat-factory/orchestration': minor
---

Local mode: first-class support for Podman, OrbStack, Colima and Apple `container`
alongside Docker (for both spinning the per-run harness containers and the Tester's
ephemeral/local test environments).

The local runner backend (`LocalDockerRunnerTransport`, now
`LocalContainerRunnerTransport`) no longer assumes the Docker CLI and Docker Desktop
networking. HOW it talks to the runtime is delegated to a `ContainerRuntimeAdapter`
(`backend/runtimes/local/src/runtimes/*`), selected by a new `LOCAL_CONTAINER_RUNTIME`
env (`docker` | `podman` | `orbstack` | `colima` | `apple`, default `docker`):

- **Docker / Podman / OrbStack / Colima** share the Docker-CLI adapter (`docker run`,
  publish `:8080` to an ephemeral host port, `cat-factory.runId` label), parameterised by
  binary + host-networking. Per-runtime defaults set the right host alias the harness
  uses to reach the LLM proxy (`host.docker.internal`, `host.lima.internal` for Colima),
  overridable via the new `LOCAL_HARNESS_HOST_ALIAS` / `PUBLIC_URL`. `PUBLIC_URL` now
  derives from the selected runtime's alias.
- **Apple `container`** (macOS) gets its own adapter: one VM per container, addressed by a
  deterministic name, connected to the container's own IP (no published-port model), via
  `container run | list | inspect | delete`.

**Tester "limited mode".** Apple `container` has no Docker-in-Docker, so the Tester's
**Local** infra mode (`docker compose up` inside the job container) can't run there. Each
adapter exposes a `localDind` capability that the local facade threads into the engine as
`localTestInfraSupported`; `ExecutionService` now refuses a local-infra Tester pipeline at
start on an incapable runtime (`tester-infra.logic.ts`), with an actionable message. The
Tester still runs there via the **Ephemeral** test environment (offloaded to a configured
environment provider — e.g. a custom container pool) or a **No infra dependencies**
service. This gate defaults to permissive (`localTestInfraSupported` defaults `true`), so
Cloudflare, Node and tests are unchanged.

`startLocal()` now logs the resolved runtime + capabilities + host alias and probes that
the CLI is installed, so a misconfiguration fails loudly at boot rather than on the first
agent job. The executor-harness image is unchanged.
