# ADR 0007: Service-owned provisioning — the what/where ÷ how split

- **Status:** Accepted (implemented)
- **Date:** 2026-07-01
- **Context layer:** backend (`@cat-factory/contracts`, `@cat-factory/kernel`,
  `@cat-factory/integrations`, `@cat-factory/server`, all three runtime facades),
  frontend (`app/`), `@cat-factory/deploy-harness`

## Context

ADR 0003 introduced pluggable ephemeral-environment providers, but bound the whole
workspace to a **single `environment_connections` row** (`kind` ∈
`manifest`/`kubernetes`/custom) and drove the Tester off a per-service
`defaultTestEnvironment` toggle (`local` compose vs `ephemeral` provisioned). That
model could not express "this service deploys Kubernetes manifests, that one a
docker-compose file, a third a custom manifest" and route each to a different engine,
and it conflated two genuinely separate ownerships in one place.

It also only ever applied **raw, apiserver-ready** manifests (the in-Worker REST
adapter). A real production ephemeral environment usually needs rendering —
Kustomize overlays, a Helm-installed controller, Gateway-API routing, a
`secretGenerator` fed from live secrets — none of which is feasible in-process on a
Worker that cannot shell out.

## Decisions

### 1. Split provisioning into "what/where" (service) and "how" (workspace/user)

- **The service (repo) owns the "what + where."** A service-frame `Block` carries a
  `provisioning` field declaring a **`provisionType`** (`kubernetes` | `docker-compose`
  | `custom` | `infraless`) plus the in-repo specifics: where its k8s manifests live
  (a colocated path **or** a separate repo + ref + path), the `renderer` (`raw` /
  `kustomize`), its compose path, or a custom `manifestId`.
- **The workspace owns the "how."** Per provision type, a **handler** = an **engine**
  (`local-docker` / `local-k3s` / `remote-kubernetes` / a `remote-custom` provider) +
  a connection (apiserver URL + token, or an HTTP management API). The same service
  config runs on whatever engine the workspace configured for that type.
- **In local mode a user may override the workspace handler** per type (the
  "this-machine" override) — e.g. point the kube handler at the developer's own
  cluster. Enforced purely by which facade wires the per-user repo/service, not a
  runtime branch in shared code.

At run time the `deployer` step **merges** the two (service source/render inputs +
workspace/user engine config), resolves a provider via `resolveInfraHandler`
(per-user override wins; `infraless` → no environment; pinned `custom` matches by key
or `acceptsManifestId`), and stands the environment up. The resolved \*\*provision type

- engine + provider\*\* are recorded on the environment record and surfaced in run
  details.

### 2. One uniform path — no local/ephemeral toggle

`defaultTestEnvironment` is removed. Every service gets its environment from the
workspace's handler for its declared type; a `local-docker` handler and a remote
cluster are just two kinds of handler, and `infraless` = no environment. Local-vs-remote
is purely _which handler the workspace configured_, never a user-facing toggle or a
special Tester branch. The Tester gate (`decideTesterInfra`) now keys off the service's
declared `provisioning`: `infraless`/undeclared passes; `docker-compose` needs a
DinD-capable runtime; `kubernetes`/`custom` need a resolvable workspace handler.

### 3. Custom types are an open, key-addressed catalog

Custom provision types are keyed by `manifestId` and sourced from both
programmatically-registered providers (a `CustomManifestTypeRegistry`, mirroring the
`registerAgentKind` seam) **and** workspace-defined UI-editable entries
(`custom_manifest_types`, merged/deduped by `manifestId`). A `remote-custom` handler's
`acceptsManifestId` is matched against a service's pinned id.

### 4. Rendering runs in a dedicated deploy container, not in-process

For anything past raw manifests (`renderer: 'kustomize'`, or any helm release / image
override / secret injection) the provider's `asyncProvision.buildProvisionJob` emits a
`deploy`-kind job (`image: 'deploy'`) dispatched through the **same runner transport**
as agent jobs, to `@cat-factory/deploy-harness` — a container carrying real
`kubectl`/`kustomize`/`helm`. Plain raw manifests keep the synchronous in-Worker REST
path. Real binaries (not an in-process JS renderer) are required because kustomize
`secretGenerator` rewrites a content-hash secret-name suffix into every reference at
build time (so the real secret must be present at render), and Helm is infeasible to
render in-process.

Every templated/secret value arrives **already resolved** in the job body (the backend
resolves against the workspace bundle before dispatch); the harness never touches the
bundle, and the apiserver + git tokens live only for the job and are scrubbed from any
output. The harness returns a structured `DeployOutcome` (namespace / url / status) that
`finalizeProvision` maps back to a `ProvisionedEnvironment`. Gateway-API URLs
(`gatewayStatus` / `httpRouteStatus`) are resolved on both the container render path and
the native REST `status()` path.

### 5. Facade wiring keeps the runtimes symmetric

- **Cloudflare** — a per-run `DeployContainer` Durable Object (the deploy-harness image),
  bound as `DEPLOY_CONTAINER`; `image: 'deploy'` routes there, agent jobs stay on
  `EXEC_CONTAINER`.
- **Node** — deploys on the workspace's self-hosted runner pool (the analogue of the
  Worker's DeployContainer); the pool forwards the `image` dispatch option and the native
  Kubernetes runner gains an `imageDeploy` variant.
- **Local** — a `NativeCliDeployTransport` (`LOCAL_DEPLOY_RUNTIME=native|container`):
  `native` shells out to the developer's own `kubectl`/`kustomize`/`helm`; `container`
  runs the deploy image per job, re-keyed so it never collides with the run's agent
  container.

### 6. Add-service auto-detect is deterministic and non-binding

A pure-TS heuristic (`detectKubernetesProvisioning`) reads a service's repo
checkout-free over a minimal `RepoFiles`-shaped reader and proposes a **recommended**
config: `renderer`, manifest-source path (ranking `overlays/*`), URL source from
manifest kinds, pinned namespace, `generatorEnvFile` secret keys (from `.env.example`),
image overrides, and helm releases as low-confidence candidates. The user always
confirms/edits — nothing is applied silently. An LLM `explore` pass for the ambiguous
cases is a deliberate, unimplemented future option.

## Consequences

- Every table/column/migration landed in **D1 and Drizzle and a cross-runtime
  conformance assertion** in the same change (per "Keep the runtimes symmetric"). New
  tables: `environment_user_handlers` (per-user, local-only), `custom_manifest_types`;
  `environment_connections` was rekeyed `(workspace_id, provision_type, manifest_id)`
  with `engine` / `backend_kind` / `accepts_manifest_id` / `handler_json` columns.
- **Backwards compatibility was a non-goal** (pre-1.0): `defaultTestEnvironment` /
  `testComposePath` / `noInfraDependencies` and the `tester.environment` agent-config
  descriptor were removed outright, with no dual-read shim.
- The deploy-harness ships as a private package with its own multi-arch image + publish
  plumbing; any change to its payload bumps the immutable image tag (today
  `cat-factory-deploy:0.2.2`).
- The **environment-under-test** axis (the live URL the Tester hits) stays distinct from
  running cat-factory's own agent workload on Kubernetes (the runner backend, ADR 0004 /
  `kubernetes-topology.md`) — same apiserver client, two different jobs.

## References

- End-to-end reference (users/operators): [`../per-service-provisioning.md`](../per-service-provisioning.md).
- Predecessor: [ADR 0003](./0003-ephemeral-environment-provider.md) (pluggable
  ephemeral-environment providers); [ADR 0004](./0004-self-hosted-runner-pool.md)
  (the runner transport this reuses for deploy jobs).
- This ADR supersedes the initiative tracker that drove the 11-slice delivery (removed
  once complete; slice history is in the git log — search commits for "Per-service
  provision types").
