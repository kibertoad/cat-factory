# Per-service provisioning (Kubernetes, compose, custom, infraless)

How cat-factory decides **what** infrastructure a service needs, **where** its manifests
live, and **how** that gets stood up when a pipeline's `deployer` step runs (and what the
`tester` step then runs against). This is the current, end-to-end reference for the
**per-service provision type** model and the Kubernetes **render/deploy** path.

> This doc covers the **environment-under-test** axis (the `EnvironmentProvider` port — the
> live URL the Tester hits). It is a different concern from running cat-factory's **agent
> workload** on Kubernetes (the runner backend), which is
> [`kubernetes-topology.md`](./kubernetes-topology.md). Two services with the same apiserver
> client, two different jobs — don't conflate them.
>
> Companion docs: [`native-environment-adapter.md`](./native-environment-adapter.md) (writing
> a custom environment backend), [`local-k3s-environments.md`](./local-k3s-environments.md)
> (pointing local mode at a local k3s), the
> [`@cat-factory/deploy-harness` README](../internal/deploy-harness/README.md) (the render
> container's contract), and the initiative tracker
> [`docs/initiatives/per-service-provision-types.md`](../../docs/initiatives/per-service-provision-types.md)
> (the full design + slice history).

## The what/where ÷ how split

The model separates two ownerships that used to be tangled in a single per-workspace
`environment_connections` row plus a per-service `local`/`ephemeral` toggle:

- **The service (repo) owns the "what + where".** A service-frame `Block` carries a
  `provisioning` field declaring a **`provisionType`** plus the in-repo specifics — where its
  Kubernetes manifests live, how to render them, its compose path, or a custom `manifestId`.
- **The workspace owns the "how".** Per provision type, a **handler** = an **engine** + a
  connection (apiserver URL + token, or an HTTP management API). The same service config runs
  on whatever engine the workspace configured for its type.
- **In local mode, a user may override the workspace handler** for a type (the "this-machine"
  override) — e.g. point the kube handler at the developer's own cluster.

At run time the `deployer` step **merges** the two — the service's source/render inputs with
the workspace (or per-user) engine config — resolves a provider, and stands the environment
up. The resolved **provision type + engine + provider** are recorded on the environment record
and surfaced in run details. There is **no** user-facing local-vs-remote toggle any more
(`defaultTestEnvironment` was removed): local-vs-remote is purely *which handler the workspace
configured*.

## Provision types

`provisionType` (`provisionTypeSchema`, `backend/packages/contracts/src/environments.ts`) is
one of:

| Type             | Service declares                                                                                   | Meaning                                                                |
| ---------------- | -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `kubernetes`     | a **manifest source** (colocated path or a separate repo) + a `renderer` + optional render inputs  | deploy Kubernetes manifests into a per-PR namespace                    |
| `docker-compose` | a compose path (+ a `localDevOnly` flag)                                                            | run a local docker-compose stack on the runtime's Docker              |
| `custom`         | a `manifestId` from the catalog (+ optional manifest path)                                          | hand off to a workspace-/code-registered custom backend                |
| `infraless`      | nothing                                                                                             | no environment — the `deployer` records a no-op, the Tester needs none |

An **undeclared** service (no `provisioning`) falls through to the legacy single-connection
path via the compat bridge, so pre-existing workspaces keep provisioning unchanged.

## Engines & backends

The workspace handler picks an **engine** (`infraEngineSchema`); a registered
**`EnvironmentBackendProvider`** in the app-owned `EnvironmentBackendRegistry`
(`backend/packages/integrations/src/modules/environments/environment-backends.ts`) implements
it. Each backend declares the engines it serves via `engines()`; the registry resolves an
engine to its backend with `byEngine()`.

| Engine             | Built-in backend (`kind`)   | Provision type     | Where it runs                                                  |
| ------------------ | --------------------------- | ------------------ | ------------------------------------------------------------- |
| `local-k3s`        | `kubernetes`                | `kubernetes`       | a local/in-cluster k3s (local-facade preset)                  |
| `remote-kubernetes`| `kubernetes`                | `kubernetes`       | an external managed cluster                                   |
| `local-docker`     | (local facade)              | `docker-compose`   | the runtime's local Docker — `local-docker` is local-only     |
| `remote-custom`    | `manifest` (or a custom one)| `custom`           | a BYO HTTP management API, or a code-registered native backend |
| `none`             | —                           | `infraless`        | nothing is provisioned                                        |

The built-in `kubernetes` backend serves `local-k3s` + `remote-kubernetes`; the generic
`manifest` HTTP backend serves `remote-custom`. A deployment can register a narrower custom
backend for `remote-custom` and constrain it via `acceptsManifestIds()` (see
[Custom manifest types](#custom-manifest-types-the-open-custom-catalog)). Adding any new
backend is the same `registry.register(provider)` seam documented in
[`native-environment-adapter.md`](./native-environment-adapter.md) — no new config variant,
table, or controller.

## The Kubernetes config split

For a `kubernetes` service the configuration is deliberately split across the two ownerships,
and `handlerConfigToBackendConfig`
(`backend/packages/integrations/src/modules/environments/infra-handler-build.ts`) merges them
at provision time:

- **Service-owned** (`serviceProvisioningSchema`, on the block's `provisioning`):
  - `manifestSource` — `colocated` (a path/dir in the PR repo, read at the PR head) **or**
    `separate` (a different `owner/repo` + optional `ref` + path), both read **checkout-free**
    over the GitHub Git Data API.
  - `renderer` — `raw` (apiserver-ready manifests) or `kustomize` (a `kustomization.yaml` tree).
  - render inputs: `images` (kustomize image overrides), `secretInjections` (a `Secret`
    resource **or** a `generatorEnvFile` `.env` written where the overlay's own
    `secretGenerator` reads it), and per-environment `helmReleases`.
- **Workspace-owned** (`kubernetesEngineConfigSchema`, on the handler): the **engine**
  connection — `apiServerUrl`, the `apiToken` (sealed), `caCertPem` / `insecureSkipTlsVerify`,
  the `namespaceTemplate` (default `cf-env-<pr>`), the URL-derivation source, and any
  **shared** (`scope: 'shared'`) helm releases.

Merge precedence for the manifest source is `service.manifestSource` > a legacy source the
compat bridge may have stored inline on the handler > a placeholder (validation/metadata
paths). Shared helm releases on the engine merge with the service's per-env releases by
release name (a same-named service release wins — no double install).

## Two apply paths: native REST vs the deploy container

How the resolved manifests reach the cluster depends on whether they need rendering
(`needsContainerRender`: `renderer: 'kustomize'`, or any helm release / image override /
secret injection):

### Native in-Worker REST (raw manifests)

For plain `raw` manifests with no render inputs, `KubernetesEnvironmentProvider`
(`backend/packages/integrations/src/modules/kubernetes/`) applies them **synchronously** over
the kube-apiserver REST client: render the namespace name, create it idempotently, template
`{{branch}}`/`{{pullNumber}}`/`{{namespace}}`/`{{image}}`/`{{repoOwner}}`/`{{repoName}}`, force
each resource into the namespace, and **server-side apply**
(`PATCH …?fieldManager=cat-factory`). Readiness converges through the status poll; the URL is
resolved from an ingress template, or read back from a `Service`/`Ingress` LoadBalancer, a
`Gateway`, or an `HTTPRoute`. Teardown deletes the namespace (404-tolerant). This path is
runtime-symmetric (pure HTTP — works on the Worker, which has no filesystem) and spins up **no
container**.

### Container-backed deploy-harness (kustomize / helm / Gateway-API)

The in-Worker REST path can only apply pre-rendered manifests. When rendering is needed —
kustomize (a `secretGenerator` rewrites a content-hashed Secret name into every reference at
build time, so the real secret must be present at render time), helm (infeasible in-process),
image overrides, or secret injections — the work moves into a **dedicated deploy container**
with real `kubectl` / `kustomize` / `helm`: the private
[`@cat-factory/deploy-harness`](../internal/deploy-harness/README.md) image, dispatched through
the shared runner transport as a new **`deploy`** dispatch kind (`image: 'deploy'`).

The async lifecycle (mirrors the agent execution flow — dispatch → park → poll → finalize):

1. `KubernetesEnvironmentProvider.asyncProvision.buildProvisionJob` returns a `deploy`-kind job
   when `needsContainerRender`, else `null` (the synchronous REST path). The pure spec builder
   (`kubernetes-deploy.logic.ts`) renders every template and resolves every `secretRef`
   backend-side, so **the harness never sees the workspace secret bundle** — every value
   arrives already resolved, and the apiserver/git tokens live only for the job.
2. `EnvironmentProvisioningService.startProvision` dispatches via the facade's `deployJobClient`,
   persists a `provisioning` env record, and parks the `deployer` step on `awaiting_job`.
3. The harness `handleDeploy` runs: clone → ensure namespace → write `secretInjections` →
   `kustomize edit set image`/`set namespace` → install `scope: 'shared'` helm releases →
   `kubectl apply -k|-f` → per-environment helm releases → `kubectl rollout status` → discover
   the env URL from `Gateway`/`HTTPRoute`/`Service`/`Ingress` status. It returns a structured
   `DeployOutcome` (`namespace`/`url`/`status`).
4. `pollProvisionJob` drives the poll (live container/subtask progress; eviction re-dispatch
   within the agent budgets); `finalizeProvision` maps the terminal `DeployOutcome` →
   `ProvisionedEnvironment` (a failed view → a `failed` env carrying the harness error).

`namespaceTemplate` semantics: **absent ⇒ honor the overlay's pinned namespace** (a shared,
fixed-namespace env); **set ⇒ override it for per-PR isolation**. The harness ensures /
monitors / reports / tears down the namespace the built manifests actually declare, never a
stray per-PR default.

### Per-facade deploy transport

The `deploy` dispatch kind is wired on every facade (the raw-manifest REST path is unchanged):

- **Cloudflare** (`runtimes/cloudflare`): a per-run `DeployContainer` Durable Object (the
  deploy-harness image), bound as `DEPLOY_CONTAINER` with a `[[containers]]` block in both
  wranglers. `CloudflareContainerTransport` routes `image: 'deploy'` to `DEPLOY_CONTAINER`
  (agent jobs stay on `EXEC_CONTAINER`). The prod config serves the managed-registry
  `cat-factory-deploy:<tag>` image.
- **Node** (`runtimes/node`): deploys on the workspace's **self-hosted runner pool** (the
  analogue of the Worker's DeployContainer). The pool forwards the `image` dispatch option, and
  the native Kubernetes runner config gains an `imageDeploy` variant. `disableDefaultDeployJobClient`
  stops the agent transport (which lacks the k8s CLIs) backing deploy.
- **Local** (`runtimes/local`): a `NativeCliDeployTransport` selected by **`LOCAL_DEPLOY_RUNTIME`**:
  - `native` (default) runs the deploy harness as a **host process** (`LOCAL_DEPLOY_HARNESS_ENTRY`)
    driving the developer's own `kubectl`/`kustomize`/`helm` against the ambient kubeconfig.
  - `container` runs the deploy-harness **image** (`LOCAL_DEPLOY_IMAGE`) per job, re-keyed by its
    own `jobId` so it never collides with the run's agent container.
  - Unwired ⇒ deploy stays off (render configs fail loudly rather than silently no-op).

## Custom manifest types (the open `custom` catalog)

The `custom` provision type is an **open catalog** keyed by `manifestId`, populated from two
sources merged by `aggregateCustomManifestTypes`
(`backend/packages/integrations/src/modules/environments/custom-manifest-types.ts`):

- **Code-registered** entries in the `CustomManifestTypeRegistry` (a backend that wants to
  advertise the manifest ids it accepts).
- **Workspace-defined**, UI-editable rows in the `custom_manifest_types` table
  (PK `(workspace_id, manifest_id)`).

A service pins a `manifestId`; a workspace's `remote-custom` handler declares which ids it
`acceptsManifestId`. Resolution (`infra-handler.logic.ts`, `resolveInfraHandler`): a pinned
`custom` matches by key or `acceptsManifestId`; a bare `custom` resolves only when exactly one
candidate exists (else a `type-mismatch`). This is how a **custom environment/deploy provider**
(registered per [`native-environment-adapter.md`](./native-environment-adapter.md) with
`engines: () => ['remote-custom']`) becomes a selectable run target for a service's `custom`
type — no new table, controller, or UI window.

## Per-user handler override (local mode)

Local mode layers a per-USER override over the workspace handler (the "this-machine" engine),
stored in the `environment_user_handlers` table (PK
`(user_id, workspace_id, provision_type, manifest_id)`, `manifest_id` `''` sentinel for
non-custom). The override wins in `resolveInfraHandler`. It is enforced purely by **which
facade wires the repo** — only the local facade wires `environmentUserHandlerRepository`, so
the per-user service + the `resolveUserHandlerOverrides` provisioning seam assemble only there
(no runtime branch in shared code). The run-initiator's `userId` is threaded via
`instance.initiatedBy`.

## Auto-detection ("Detect from repo")

A deterministic, pure-TS heuristic (`provision-detect.logic.ts`, `detectProvisioning`) reads a
service's repo **checkout-free** (targeted directory listings + YAML parsing, a hard read
budget, no LLM, no clone) and proposes a **non-binding** recommended provisioning config. The
user always confirms/edits — nothing is applied silently. What it infers, by confidence:

- **High confidence (deterministic):** the manifest root (the service dir or a
  `k8s`/`kubernetes`/`deploy`/… subdir), `kubernetes` vs `docker-compose` vs `infraless`, the
  `renderer` (`kustomization.yaml` ⇒ `kustomize`), the URL source from manifest kinds
  (`Ingress` ⇒ ingress status/template, `Gateway`/`HTTPRoute` ⇒ gateway/route status,
  `Service type: LoadBalancer` ⇒ service status), a pinned `namespace`, `generatorEnvFile`
  secret-injection **keys** read from a `.env.example` (values stay the user's), and `images`
  override candidates (default `newTagTemplate: '{{branch}}'`).
- **Lower confidence (surfaced as candidates, never auto-picked):** **which** overlay under
  `overlays/*` is the ephemeral one (ranked by name — `prenv`/`preview`/`pr`/`ephemeral`/`dev`),
  and helm releases declared parseably (`helmfile.yaml` / a `Chart.yaml` dependency).

Wired as `EnvironmentConnectionService.detectServiceProvisioning` → `POST
…/environments/detect-provisioning`; the SPA's `ServiceTestConfig.vue` prefills
`block.provisioning` with the per-field confidence notes.

## The Tester gate

With `defaultTestEnvironment` gone, the Tester's infra readiness is driven entirely by the
service's declared `provisioning` (`tester-infra.logic.ts`, `decideTesterInfra`):

- `infraless` / undeclared → **pass** (no infra needed).
- `docker-compose` → pass only on a **DinD-capable** runtime (else `tester_infra_unsupported`
  "limited mode").
- `kubernetes` / `custom` → pass only when a workspace handler **resolves** (else
  `provision_type_unhandled`).

The gate resolves the handler lazily via `EnvironmentProvisioningService.canProvision` (a
pass-through when the provisioning seam is unwired).

## API surface

Workspace-scoped per-type handlers + the custom-type catalog + detection
(`@cat-factory/server` `EnvironmentController`, contracts in
`backend/packages/contracts/src/routes/environments.ts`), mounted under `/workspaces/:ws`:

```
GET    /workspaces/:ws/environments/handlers                        the batched handler bundle + custom-type catalog
POST   /workspaces/:ws/environments/handlers                        register/replace a per-type handler (config + secrets)
PATCH  /workspaces/:ws/environments/handlers/:provisionType/secrets rotate a handler's secret bundle (?manifestId for custom)
DELETE /workspaces/:ws/environments/handlers/:provisionType         unregister a handler (?manifestId for custom)
PUT    /workspaces/:ws/environments/custom-types/:manifestId        upsert a workspace custom manifest type
DELETE /workspaces/:ws/environments/custom-types/:manifestId        remove a workspace custom manifest type
POST   /workspaces/:ws/environments/detect-provisioning             non-binding recommended config from the repo
```

Local-mode-only per-user override (`EnvironmentUserHandlerController`, mounted at ROOT with no
`/workspaces` prefix, 401 without a user, 503 where unwired):

```
GET    /me/environment-handlers/:workspaceId                        list this user's overrides
PUT    /me/environment-handlers/:workspaceId/:provisionType         upsert an override
DELETE /me/environment-handlers/:workspaceId/:provisionType         remove an override
```

The legacy single-connection endpoints (`GET|POST|PUT|DELETE
/workspaces/:ws/environments/connection`, `…/connection/secrets`, `…/connection/test`,
`…/connection/validate-repo`, `…/connection/bootstrap-repo`) still exist as the **compat
bridge** over the primary handler; the per-type `describe`/`test`/`validate`/`bootstrap`
endpoints remain on it for now.

## Persistence & runtime parity

Every table/column mirrors D1 ⇄ Drizzle with a cross-runtime conformance assertion (CLAUDE.md
"Keep the runtimes symmetric"):

- `environment_connections` — rekeyed to `(workspace_id, provision_type, manifest_id)`; columns
  `provision_type`, `manifest_id`, `engine`, `backend_kind` (the registry kind that builds the
  provider), `accepts_manifest_id`, `handler_json`, and the sealed secret bundle.
- `environment_user_handlers` — the local-only per-user override (PK
  `(user_id, workspace_id, provision_type, manifest_id)`).
- `custom_manifest_types` — the workspace catalog (PK `(workspace_id, manifest_id)`).
- `environments` — gains `provision_type` / `engine`, recorded on both the success and failed
  paths.
- `blocks` — gains `provisioning`; dropped `default_test_environment` / `test_compose_path` /
  `no_infra_dependencies`.

The render inputs (`renderer`/`images`/`helmReleases`/`secretInjections`) ride as nested JSON
inside the existing `handler_json` / service `provisioning` TEXT columns, so they needed **no**
migration. The `environment-handlers` conformance suite runs under both runtimes (real D1 in
workerd, real Postgres for Node), and a shared assertion drives the engine's async render path
(provider's `deploy` kind + `image: 'deploy'` forwarded through the wired `deployJobClient`,
finalized round-trip through each facade's registry repo).
