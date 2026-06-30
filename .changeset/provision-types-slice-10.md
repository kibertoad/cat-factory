---
'@cat-factory/contracts': minor
'@cat-factory/integrations': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': minor
'@cat-factory/worker': minor
'@cat-factory/node-server': minor
'@cat-factory/local-server': minor
---

Per-service provision types (Phase 2, slice 10): facade wiring for the async, container-backed
Kubernetes deploy lifecycle + the local-mode native-CLI deploy transport. A `deployer` step whose
manifests need rendering (kustomize/helm/Gateway-API) now stands its environment up in a real
deploy container (or, locally, the host CLIs) on every runtime — slice 9's `deployJobClient` /
`resolveDeployCloneTarget` seams are no longer unwired. The synchronous raw-manifest REST path is
unchanged.

- **Cloudflare Worker**: a new `DeployContainer` Durable Object (per-run, the separate
  deploy-harness image — `kubectl`/`kustomize`/`helm`) bound as `DEPLOY_CONTAINER`, with its
  `[[containers]]` block + binding + a `v4` migration in both wranglers and the class exported from
  the worker entry. The `image: 'deploy'` dispatch routes here while agent jobs stay on
  `ExecutionContainer`. `selectDeployDeps` wires a deploy-dedicated `RunnerJobClient` (over the
  deploy namespace) + `resolveDeployCloneTarget` when the binding + GitHub App are present.
- **Node**: wires the default pool-backed `deployJobClient` (`new RunnerJobClient(resolveTransport)`)
  - a `resolveDeployCloneTarget` built from the App token mint, both overridable by a sibling facade.
    The self-hosted runner pool now forwards the `image` dispatch option (the generic
    `RunnerPoolTransport` + `HttpRunnerPoolProvider` expose it as a first-class `{{input.image}}`
    variable, and the native Kubernetes runner config gains an `imageDeploy` variant) so a pool pulls
    the deploy-harness image for `image: 'deploy'`.
- **Local**: a new `NativeCliDeployTransport` (`LOCAL_DEPLOY_RUNTIME=native|container`). `native`
  (default) runs the deploy harness as a host process driving the developer's own
  `kubectl`/`kustomize`/`helm`; `container` runs the deploy image per job, keyed by its own job id so
  it never collides with the run's agent container. The clone target is inherited from Node's default
  (PAT mint + GitLab-aware origin).
- **Shared**: `@cat-factory/server` exports `makeResolveDeployCloneTarget` (compose a deploy clone
  resolver from a repo-target walk + token mint, with a per-facade clone-URL override). A latent bug
  is fixed in `RunDispatcher.completeDeployerStep`: the async deploy success path now refreshes the
  step's environment projection, so a finalized env shows `ready` + its URL instead of the stale
  `provisioning` snapshot stamped at park time.
- **Conformance**: the cross-runtime suite drives the full container render path — dispatch a
  `deploy` job (asserting the `image: 'deploy'` variant), poll a stubbed view, finalize — and asserts
  it settles to an identical `ProvisionedEnvironment` on D1 and Postgres.
