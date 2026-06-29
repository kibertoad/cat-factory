---
'@cat-factory/integrations': patch
---

Add real-cluster integration tests for the native Kubernetes runner + environment backends,
and colocate all Kubernetes code under one module.

The two Kubernetes adapters (`KubernetesRunnerTransport`, `KubernetesEnvironmentProvider`)
were covered only by unit tests that stub `fetch` with hand-crafted responses, so the
apiserver behaviours they depend on — the pod-proxy URL form, `404 → eviction`, server-side
apply, namespace `409` idempotency, Deployment readiness, and the `status.loadBalancer` shape
— were never validated against a real apiserver. A new integration suite (`*.it.spec.ts`, run
via `pnpm --filter @cat-factory/integrations test:integration`) now drives both adapters
against a real **k3d (k3s-in-Docker)** cluster, asserting the pod-proxy round-trip and the k3s
ServiceLB-assigned URL for real. It self-skips when the `K8S_IT_*` cluster env is unset, and
in CI runs as a blocking job gated behind a paths filter so the k3d cluster only spins up when
Kubernetes code changes.

That real-cluster suite caught a compatibility bug in the environment backend: its
server-side apply sent the `application/apply-patch+json` media type, which only newer
apiservers accept, so applying manifests `415`d on a stock/older cluster. It now sends
`application/apply-patch+yaml` with the same JSON body (JSON is valid YAML), which every
apiserver since 1.22 accepts — matching what kubectl/client-go do.

The `kubernetesRunnerBackend` / `kubernetesEnvironmentBackend` registry entries moved into
the `modules/kubernetes/` folder (the generic registries import them for side-effect
registration); their exported names and the package's public surface are unchanged.
