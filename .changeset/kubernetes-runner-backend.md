---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/integrations': minor
'@cat-factory/server': minor
'@cat-factory/worker': minor
'@cat-factory/node-server': minor
'@cat-factory/orchestration': patch
'@cat-factory/app': patch
---

Add Kubernetes support for executor containers via a universal "agent runner backend"
abstraction.

The self-hosted runner pool is generalized into a discriminated runner-backend
connection (a new `kind` field): `manifest` (the existing BYO HTTP scheduler pool) and
`kubernetes` (new), with a `registerRunnerBackend` provider-registry seam so future
backends (Nomad, EKS, …) are a single registry entry + a config variant + a UI form — no
new table, service, controller, or integration window.

The Kubernetes backend (`KubernetesRunnerTransport`, target k8s 1.35+) runs one bare Pod
per run and reaches the per-pod executor-harness through the kube-apiserver **pod-proxy
subresource** (Bearer ServiceAccount token), so the orchestrator needs only HTTPS to the
apiserver — no in-cluster networking or per-run Service — and full `RunnerJobView`
fidelity is preserved with zero executor-harness changes. It is wired symmetrically into
both the Cloudflare and Node facades (and local mode via Node), and surfaced in the
existing runner-backend Integrations window via a backend-type selector.

BREAKING (pre-1.0): the `runner-pool/connection` register/test wire shape now takes a
discriminated `config` instead of a bare `manifest`, and the `runner_pool_connections`
table gains a `kind` column (existing rows backfill to `manifest`). The
`executor-harness` image is unchanged (no image/tag bump).
