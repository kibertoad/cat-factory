---
'@cat-factory/deploy-harness': minor
---

New private package `@cat-factory/deploy-harness` (Phase 2, slice 7 — the deploy container
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
