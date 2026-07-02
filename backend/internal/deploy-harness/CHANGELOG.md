# @cat-factory/deploy-harness

## 0.2.5

### Patch Changes

- 9577c4a: Fix a batch of native-mode (`LOCAL_NATIVE_AGENTS`) agent-harness bugs:

  - The harnesses (executor + deploy) now shut down gracefully on SIGTERM/SIGINT:
    every running job is aborted (`JobRegistry.abortAll`) so in-flight `claude`/
    `codex`/git/kubectl children are killed instead of being orphaned. Previously a
    dev-server restart left the agent CLI running unsupervised on the developer's
    login. The abort now targets the child's whole process group (POSIX), so the
    CLI's own grandchildren (a shell tool, a build, its git) die with it rather than
    reparenting to init. Shutdown exits as soon as the aborted jobs settle (capped at
    6s) instead of always waiting the fixed window. Both harness servers also honor a
    new `HARNESS_BIND_HOST` env, which the native transport sets to `127.0.0.1` so the
    unsandboxed agent-spawning API is no longer reachable from the LAN (containers keep
    binding all interfaces).
  - The native host-process transport sanitizes the harness child's environment to an
    allow-list (`LOCAL_HARNESS_ENV_ALLOW` extends it), so the orchestrator's secrets
    (DATABASE_URL, ENCRYPTION_KEY, GITHUB_PAT, provider keys) no longer leak into the
    ambient agent's env; the inline ambient CLI runner is sanitized the same way. The
    allow-list keeps the TLS trust-anchor vars (NODE_EXTRA_CA_CERTS, SSL_CERT_FILE, ...)
    alongside the proxy vars, so a corporate TLS-terminating proxy still works. The
    deploy transport keeps full inheritance (kubectl/helm need ambient cluster env).
  - Process-lifecycle fixes in `LocalProcessRunnerTransport`: a harness that never
    becomes healthy is killed instead of leaking one process per retry, and
    `shutdown()` racing an in-flight lazy start now kills the child instead of
    resurrecting it. The local/Node graceful-shutdown path now invokes the
    container's `onShutdown`, which stops the native harnesses; that call is isolated
    in its own try so a failing pg-boss/pool teardown can't skip it.
  - `NativeRoutingRunnerTransport` no longer reports a blanket eviction for refs it
    doesn't know: after an orchestrator restart both `poll` and `release` fall back to
    the container leg (which re-finds a per-run container by label), so a still-running
    container job is re-attached / torn down instead of spuriously re-driven or leaked.
  - Config typos are no longer silent: unrecognized `LOCAL_NATIVE_AGENTS` tokens and
    an unrecognized/under-configured `LOCAL_DEPLOY_RUNTIME` now log a boot warning
    (behavior still fails safe).

## 0.2.3

### Patch Changes

- 858799e: Per-service provision types (Phase 2, slice 8): the `KubernetesEnvironmentProvider` render
  path. The provider now implements the `asyncProvision` capability — it builds a
  container-backed deploy job (real `kubectl`/`kustomize`/`helm`) for any config the in-Worker
  REST path can't handle, and maps the harness outcome back into a `ProvisionedEnvironment`.

  - `buildProvisionJob` returns a `deploy`-kind job (`image: 'deploy'`) when the source needs
    rendering (`renderer: 'kustomize'`) or declares helm releases / image overrides / secret
    injections, and `null` (use the synchronous REST `provision()` path) for plain raw
    manifests. Every template is rendered and every `secretRef` is resolved backend-side, so
    the job body the harness receives carries concrete values only.
  - `finalizeProvision` maps the harness's `DeployOutcome` (namespace / url / status) onto a
    `ProvisionedEnvironment`; a failed job becomes a `failed` environment carrying the error.
  - The native REST `status()` path gained the Gateway-API URL resolvers — `gatewayStatus`
    (prefer a concrete listener hostname over the assigned address) and `httpRouteStatus` (the
    route's own hostname, else the parent Gateway's address read in the parentRef's namespace)
    — so a kustomize/Gateway env resolves its URL on ongoing status polls. REST teardown/status
    are otherwise unchanged.
  - Contracts: a `kubernetesProvisionConfigSchema` (the combined cluster + URL + manifest source
    config PLUS the render inputs) is what the deploy adapter consumes; `EnvironmentConnectionService`
    merges the service's render inputs (image overrides, per-environment helm releases, secret
    injections) with the workspace engine config (shared helm releases) at provision time.
  - Kernel: `DeployCloneTarget` + `DeployProvisionInputs` (the clone coordinates + git token + job
    ref the stateless provider can't derive itself) on `ProvisionEnvironmentRequest`, supplied by
    the provisioning service before dispatch.
  - Deploy harness: when per-PR isolation is NOT requested, the harness now reads the namespace the
    built manifests actually declare (an overlay's own `namespace:`) and ensures / monitors /
    reports / tears down THAT namespace instead of the backend's per-PR default — so an
    overlay-pinned (shared) namespace no longer leaves an empty namespace behind with no URL and a
    wrong-target teardown. Image tag bumped to `0.2.2`.
  - A new optional `rolloutTimeoutSeconds` on the kube engine config is forwarded to the deploy
    job (the harness's per-Deployment rollout wait); `buildDeployJobSpec` now fails fast when the
    cluster `apiToken` secret is unset instead of dispatching an unauthenticated job. Same-named
    shared/per-env helm releases are merged by name (service overrides engine — no double install).

  The async deployer lifecycle (dispatch/poll/park) and facade wiring follow in slices 9–10, so
  nothing dispatches a deploy job yet; this slice adds + unit-tests the provider methods.

## 0.2.1

### Patch Changes

- 65768ce: Add a k3d integration suite for the deploy harness that drives `handleDeploy` against a real
  Kubernetes apiserver with the real kubectl/kustomize CLIs: clone → namespace → secret
  injection (a `Secret` and a kustomize `generatorEnvFile` content-hash rewrite) → kustomize
  image/namespace edits → `kubectl apply` → rollout → URL discovery, plus the slow-rollout
  (`provisioning`) and invalid-manifest failure/redaction paths and the `POST /jobs` + `GET
/jobs/{id}` server contract. It reuses the existing `test-k8s` job's k3d cluster + `K8S_IT_*`
  connection and is path-gated so it runs only when the harness changes. Test/CI only — no
  runtime/image behaviour changes.

## 0.2.0

### Minor Changes

- ee76986: New private package `@cat-factory/deploy-harness` (Phase 2, slice 7 — the deploy container
  payload). A slim container image (Node + pinned `kubectl`/`kustomize`/`helm`, no Pi, no
  Docker-in-Docker) that renders a service's Kubernetes manifests and applies them into a
  per-PR namespace — the container-backed deploy adapter the native in-Worker REST path can't
  be (kustomize `secretGenerator` content-hashing and helm rendering need real binaries).

  - Same HTTP contract as `@cat-factory/executor-harness` (`POST /jobs` + `GET /jobs/{id}` +
    the optional `x-harness-secret` gate), so the existing `RunnerTransport` drives both. The
    single dispatchable kind is `deploy`, mirroring kernel's `RunnerDispatchKind`.
  - `handleDeploy` flow: clone the manifests repo → ensure the namespace → write resolved
    secret injections (a `Secret` resource, or a `generatorEnvFile` `.env` into the overlay
    tree) → `kustomize edit set namespace`/`set image` → install `scope: 'shared'` helm
    releases → `kubectl apply -k|-f` → per-environment helm releases → `kubectl rollout
status` → discover the env URL (Gateway / HTTPRoute / Service / Ingress status). It
    returns a structured `DeployOutcome` (namespace, url, status) on the job result's `custom`
    channel for the backend to map into a `ProvisionedEnvironment`.
  - Every templated/secret value arrives ALREADY RESOLVED in the job body — the harness never
    touches the workspace secret bundle. The apiserver token + git token live only for the job
    (an ephemeral kubeconfig / git askpass) and are scrubbed from any surfaced output.

  Private (not published to npm); its multi-arch image is the deploy-time artifact and the
  package `version` is the image tag, exactly like the executor harness. The provider render
  path (slice 8), the async deployer lifecycle (slice 9), and the facade/CF-container wiring
  (slice 10) follow.
