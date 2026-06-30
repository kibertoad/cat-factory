---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/integrations': minor
'@cat-factory/deploy-harness': minor
---

Per-service provision types (Phase 2, slice 8): the `KubernetesEnvironmentProvider` render
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
  wrong-target teardown. Image tag bumped to `0.2.0`.
- A new optional `rolloutTimeoutSeconds` on the kube engine config is forwarded to the deploy
  job (the harness's per-Deployment rollout wait); `buildDeployJobSpec` now fails fast when the
  cluster `apiToken` secret is unset instead of dispatching an unauthenticated job. Same-named
  shared/per-env helm releases are merged by name (service overrides engine — no double install).

The async deployer lifecycle (dispatch/poll/park) and facade wiring follow in slices 9–10, so
nothing dispatches a deploy job yet; this slice adds + unit-tests the provider methods.
