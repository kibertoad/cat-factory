# Kubernetes ephemeral environments (incl. local k3s)

The Kubernetes environment backend provisions a per-PR preview environment by applying an
operator-authored set of Kubernetes/k3s manifests into a fresh namespace, reached over the
kube-apiserver. It reuses the same apiserver client (bearer token + custom-CA TLS) as the
[native Kubernetes runner backend](./adr/0003-ephemeral-environment-provider.md), and plugs
in through the app-owned env-backend registry (`EnvironmentBackendRegistry`) — the same seam a
third-party adapter uses (registered by reference via `createBackendRegistries()`). Selection is per-workspace: a workspace connects either the generic
`manifest` HTTP backend or the native `kubernetes` backend.

## How it works

- **Provision**: render the namespace name (`namespaceTemplate`, default `cf-env-<pr>`), create
  it, read the manifests from the configured source, template `{{branch}}`/`{{pullNumber}}`/
  `{{namespace}}`/`{{image}}`/`{{repoOwner}}`/`{{repoName}}`, force each resource into the
  namespace, and apply via server-side apply (`PATCH …?fieldManager=cat-factory`). Returns
  `provisioning`; readiness converges through the status poll.
- **Status**: aggregate the namespace's Deployments (`availableReplicas` vs desired) and resolve
  the URL (ingress-template host, or read-back of an applied Service/Ingress LoadBalancer).
- **Teardown**: delete the namespace (cascades), tolerant of a 404.

Manifests come from one of two sources (both read checkout-free via the GitHub Git Data API):

- `colocated` — a path/dir in the PR repo, read at the PR head branch.
- `separate` — a different repo (`owner/repo` + optional `ref`) + path, for when the Kubernetes
  definition lives outside the service repo.

Supported manifest kinds are a built-in allow-list (Deployment, Service, Ingress, ConfigMap,
Secret, ServiceAccount, PersistentVolumeClaim, StatefulSet, Job, HTTPRoute, …); an unlisted kind
is rejected with a clear error.

## Pointing at an existing local k3s (local mode)

Local mode (`@cat-factory/local-server`) inherits the Node facade's environment wiring, so a
developer running a local k3s (k3d, Rancher Desktop, or k3s-in-docker) can use the `kubernetes`
backend with no extra code:

1. Bring up a cluster and create a ServiceAccount + token with RBAC to create/patch/delete the
   namespaced resources above (and `namespaces`).
2. Connect a `kubernetes` environment in the UI (Integrations → Environments), pointing at the
   apiserver:
   - `apiServerUrl`: `https://localhost:6443` (or the k3d load-balancer port).
   - `caCertPem`: the cluster CA (k3s self-signs), or set `insecureSkipTlsVerify` for a throwaway
     cluster. Node/local honors custom-CA TLS via undici; the Cloudflare Worker does not, so a
     CA/insecure config is rejected there at registration.
   - `apiToken`: the ServiceAccount token (stored encrypted).
   - `manifestSource` + `url` (ingress-template host like `{{branch}}.127.0.0.1.nip.io` works with
     k3s Traefik; or a `serviceStatus` LoadBalancer with k3s ServiceLB).

Local mode widens the environment URL-safety policy by default (`ENVIRONMENTS_ALLOW_HTTP_URLS`

- a loopback/LAN `ENVIRONMENTS_ALLOW_URL_HOSTS` allow-list: `localhost`, `127.0.0.1`,
  `host.docker.internal`, `.localhost`, `.local`, `.nip.io`, `.sslip.io`) so the `http://localhost`
  / ingress-host URL the provider returns is accepted. Add more hosts via
  `ENVIRONMENTS_ALLOW_URL_HOSTS`. Hosted facades keep the strict public-https default.

## Running AGENTS on a local k3s (runner backend)

The same cluster can also back the **agent runner** (not just Tester environments): connect a
native `kubernetes` runner backend so each agent run is a pod in the cluster. Local mode
surfaces a one-click **Local Kubernetes (k3s)** preset for this in the Infrastructure window's
"Agent containers" list — it prefills the runner form for a local cluster
(`apiServerUrl: https://127.0.0.1:6443`, `namespace: cat-factory`, `insecureSkipTlsVerify`, and
the executor `image` from the deployment's `LOCAL_HARNESS_IMAGE`), so the operator only pastes a
ServiceAccount token. No backend change is needed: the apiserver-URL validator already permits
loopback/private hosts (it only requires `https` and blocks the cloud-metadata endpoint), and
Node/local honors `insecureSkipTlsVerify`/`caCertPem` via undici. The token needs RBAC to
create/get/delete `pods` and `pods/proxy` in the namespace.

## Future: managed local k3s lifecycle

Today local mode points at an **existing** cluster. A follow-up could have local mode manage the
cluster lifecycle itself — a cluster adapter analogous to the per-run `ContainerRuntimeAdapter`
(`runtimes/local/src/runtimes/*`). Sketch of what that needs:

- **Bring-up / tear-down**: create a k3s cluster on demand (k3d `cluster create`, or k3s in a
  container), and delete it (or stop it) when idle. Selected via a `LOCAL_K8S_RUNTIME` env knob
  (`k3d` | `none`), mirroring `LOCAL_CONTAINER_RUNTIME`.
- **Credentials**: read the generated kubeconfig, mint/extract a ServiceAccount token + the
  cluster CA, and seed the workspace's `kubernetes` connection automatically (a `linkCluster`
  helper, analogous to local mode's `linkRepo`).
- **Image loading**: a local image the PR built must be importable into the cluster (`k3d image
import`) rather than pulled from a registry — wire the provision flow to load `{{image}}` when
  it's a local tag.
- **URL exposure**: decide the default ingress story (k3d maps a host port to Traefik; the
  ingress-template host should resolve to that port). Document the `nip.io`/`localhost` host
  pattern that resolves to the mapped port.
- **Isolation between concurrent runs**: per-PR namespaces already isolate within one cluster;
  decide whether concurrent runs share one managed cluster (cheaper) or get one each (stronger).
- **Open questions**: cluster reuse vs per-run; how long an idle managed cluster lives before the
  sweeper tears it down; surfacing bring-up progress/errors in the run UI.

This is design-only; no code ships for the managed lifecycle yet.
