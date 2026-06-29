---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/integrations': minor
'@cat-factory/server': minor
'@cat-factory/worker': minor
'@cat-factory/node-server': minor
'@cat-factory/local-server': minor
'@cat-factory/orchestration': patch
'@cat-factory/app': patch
---

Add a Kubernetes-based ephemeral-environment provider, selected per workspace through an
env-backend registry that mirrors the runner-pool backends.

The ephemeral-environment connection is now discriminated by a `kind` field (`manifest` =
the generic BYO HTTP management API, `kubernetes` = native per-PR namespaces), resolved
through a `registerEnvironmentBackend` provider-registry seam — so a native backend is a
single registry entry + a config variant + a UI form, with no new table/service/controller.

The Kubernetes backend applies an operator-authored set of k3s/Kubernetes manifests into a
per-PR namespace over the kube-apiserver (server-side apply), reusing the Kubernetes runner
backend's shared apiserver client (Bearer ServiceAccount token + custom-CA TLS). Manifests
are read checkout-free from either the PR repo (co-located) or a separate repo; the URL is
derived from an ingress host template or read back from an applied Service/Ingress
LoadBalancer (k3s Traefik / ServiceLB). It is wired symmetrically into the Cloudflare and
Node facades (the Worker rejects a custom-CA config it can't honor), and local mode can
point at a developer-run local k3s (its env URL-safety policy is widened to loopback/LAN).
See `backend/docs/local-k3s-environments.md`.

BREAKING (pre-1.0):

- The `environments/connection` register/test wire shape now takes a discriminated `config`
  instead of a bare `manifest`, and the `environment_connections` table gains a `kind`
  column (existing rows backfill to `manifest`).
- The `EnvironmentProvider` provision request gains optional `runRepo` / `resolveRepoFiles`
  seams (additive).
- The deployment-wide environment-provider injection option
  (`buildNodeContainer({ environmentProvider })` / `startLocal({ environmentProvider })`) is
  removed — native adapters register via `registerEnvironmentBackend` instead.
