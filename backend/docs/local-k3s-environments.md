# Kubernetes ephemeral environments (incl. local k3s)

> **Operating this is on the website**:
> [Provision Ephemeral Environments](https://www.catfactory.ai/operate/environments.html)
> owns connecting and running a backend, and
> [Deploy on Kubernetes](https://www.catfactory.ai/deploy/kubernetes.html) owns the cluster
> side. This page is the backend's own DESIGN: the render/deploy engines and the namespace
> lifecycle.

The Kubernetes environment backend provisions a per-PR preview environment by applying an
operator-authored set of Kubernetes/k3s manifests into a fresh namespace, reached over the
kube-apiserver. It reuses the same apiserver client (bearer token + custom-CA TLS) as the
[native Kubernetes runner backend](./adr/0003-ephemeral-environment-provider.md), and plugs
in through the app-owned env-backend registry (`EnvironmentBackendRegistry`): the same seam a
third-party adapter uses (registered by reference via `createBackendRegistries()`). Selection is per-workspace: a workspace connects either the generic
`manifest` HTTP backend or the native `kubernetes` backend.

> **Where the manifest config lives (the per-service split).** Under the current
> [per-service provisioning](./per-service-provisioning.md) model, **the service (repo) owns
> the manifest source + render inputs** (`block.provisioning`: colocated/separate path,
> `renderer`, image overrides, secret injections, per-env helm releases), while the **workspace
> handler owns the engine** (apiserver URL + token + CA + URL derivation + shared helm). The
> `kubernetes` backend serves two engines: `local-k3s` (this doc) and `remote-kubernetes`. The
> setup below is the **engine** side (the apiserver connection); a `raw`-manifest service is
> applied synchronously over the apiserver REST client (described here), while a
> `kustomize`/helm/Gateway service is rendered in the **deploy container**: see
> [per-service-provisioning.md](./per-service-provisioning.md).

## How it works

- **Provision**: render the namespace name (`namespaceTemplate`, default
  `cf-env-<repoName>-pr<pullNumber>`), create
  it, read the manifests from the configured source, template `{{branch}}`/`{{pullNumber}}`/
  `{{namespace}}`/`{{image}}`/`{{repoOwner}}`/`{{repoName}}`, force each resource into the
  namespace, and apply via server-side apply (`PATCH …?fieldManager=cat-factory`). Returns
  `provisioning`; readiness converges through the status poll.
- **Registry auth (clusters on this machine only)**: between the parse and the apply, write the
  run's own git credential into the namespace as a `dockerconfigjson` Secret and attach it to
  `default` plus every ServiceAccount the manifests declare or name. Details + the gate below.
- **Status**: aggregate the namespace's Deployments (`availableReplicas` vs desired) and resolve
  the URL (ingress-template host, or read-back of an applied Service/Ingress LoadBalancer).
- **Teardown**: delete the namespace (cascades), tolerant of a 404.

Manifests come from one of two sources (both read checkout-free via the GitHub Git Data API):

- `colocated`: a path/dir in the PR repo, read at the PR head branch.
- `separate`: a different repo (`owner/repo` + optional `ref`) + path, for when the Kubernetes
  definition lives outside the service repo.

Supported manifest kinds are a built-in allow-list (Deployment, Service, Ingress, ConfigMap,
Secret, ServiceAccount, PersistentVolumeClaim, StatefulSet, Job, HTTPRoute, …); an unlisted kind
is rejected with a clear error.

## Pointing at an existing local k3s (local mode)

Local mode (`@cat-factory/local-server`) inherits the Node facade's environment wiring, so a
developer running a local k3s (k3d, Rancher Desktop, k3s-in-docker, or k3s in WSL2 on Windows)
can use the `kubernetes` backend with no extra code.

### Guided setup (recommended): `cat-factory k3s`

`@cat-factory/cli` ships a guided command that does the whole dance below on your behalf. What it
probes, offers, provisions and hands off, plus its flags and the deploy-runner step it prints, is on
the website's
[local k3s guided setup](https://www.catfactory.ai/deploy/kubernetes.html#local-k3s-guided-setup).

Prefer it. The manual path below is the escape hatch for a host the guided flow cannot run on, and
it is here rather than on the website because it is a `kubectl apply` against a file this repository
ships.

### Manual setup (the advanced / escape-hatch path)

If you'd rather wire it by hand (or the guided flow can't run on your host), do it directly:

1. Bring up a cluster and create a ServiceAccount + token with RBAC to create/patch/delete the
   namespaced resources above (and `namespaces`).
2. Connect a `kubernetes` **handler** in the UI (Infrastructure → environments, the per-type
   configurator) on the `local-k3s` engine, pointing at the apiserver:
   - `apiServerUrl`: `https://localhost:6443` (or the k3d load-balancer port).
   - `caCertPem`: the cluster CA (k3s self-signs), or set `insecureSkipTlsVerify` for a throwaway
     cluster. Node/local honors custom-CA TLS via undici; the Cloudflare Worker does not, so a
     CA/insecure config is rejected there at registration.
   - `apiToken`: the ServiceAccount token (stored encrypted).
   - the **URL derivation** (an ingress-template host like `{{namespace}}.127.0.0.1.nip.io`, or a
     `serviceStatus` LoadBalancer with k3s ServiceLB) + the `namespaceTemplate`. These two are
     configured separately and are only correct **together**: see the third requirement below.

     An ingress-template host needs **four** things, and none is implied by the others. First an
     **ingress controller** in the cluster: a default k3d/k3s cluster bundles Traefik, but a
     cluster created with `--disable=traefik` has none, and kind ships none at all. Second a
     **host port published into it**: every local distribution runs the cluster inside Docker and
     forwards only the ports it was asked for at CREATE time (`k3d cluster create -p
"80:80@loadbalancer"`, kind's `extraPortMappings`), and neither can be added to a cluster that
     already exists. Without the port, a name that does resolve to loopback (see the third
     requirement for which ones do) finds nothing listening, environments still reach `ready`
     (readiness is workload readiness, not an HTTP probe), and the failure surfaces much later at
     the `tester` step.
     `cat-factory k3s` checks both and refuses to prefill a template it has not established; the
     manual path is yours to check with `kubectl get ingressclass` and a `curl` at the host port.
     Also set the URL **scheme** to `http`: a local ingress controller serves TLS with a
     self-signed certificate, so an `https` environment URL fails on the certificate instead.

     Third, your manifests' Ingress must name a class that controller actually publishes, and this
     is the one with no observable symptom of its own. An Ingress naming
     `ingressClassName: nginx` on a cluster running Traefik is ACCEPTED by the apiserver, watched
     by nothing, and left with an empty `status.loadBalancer`; the pods roll out, the environment
     reports `ready`, and the URL answers nothing. **Leave `ingressClassName` unset** so the
     cluster's default class claims it (k3s annotates its `traefik` class
     `ingressclass.kubernetes.io/is-default-class: "true"`), which is also the portable choice: a
     pinned class is wrong on every cluster running something else. The platform now grades this
     rather than assuming it, so a Traefik cluster and an `nginx`-pinned manifest fail at the
     `deployer` step with both names in the message (`config_incomplete`) instead of at the tester
     a quarter of an hour later. The grade needs a cluster-scoped **`ingressclasses` get/list/watch**
     grant on the ServiceAccount, which `cat-factory k3s` now includes; without it the read is
     refused and the check stands down to the previous behaviour rather than failing anything.

     Fourth, and the one that reads as a cluster fault when it is a naming one: with a wildcard-DNS
     host the rendered name must carry **exactly one address**, which constrains the
     `namespaceTemplate` it is composed with. `nip.io` and `sslip.io` answer from the leftmost
     four-octet run in a name and treat `-` and `.` as the same separator, so a namespace ending
     in a separator plus digits contributes an address of its own and wins:

     ```
     cf-env-catalog-api-5.127.0.0.1.nip.io  ->  5.127.0.0     (somebody else's network)
     cf-env-catalog-api-pr5.127.0.0.1.nip.io -> 127.0.0.1     (one character's difference)
     ```

     **The platform's own default namespace used to have that shape for every pull request ever
     opened** (`cf-env-<repoName>-<pullNumber>`), so leaving `namespaceTemplate` unset and pairing
     it with a `nip.io` host was the trap rather than an exotic case. It cost a run four agents
     and a merge-ready pull request before its `tester` step reported eight minutes of connection
     failures against an address that was never this cluster. Two things changed. The defaults
     render `pr<n>` now (`cf-env-<repoName>-pr<pullNumber>`, and `cat-factory k3s` writes
     `cf-env-pr{{pullNumber}}`), so an untouched setup composes correctly; and the provider
     refuses a mis-resolving provision outright (`config_incomplete`, naming both addresses)
     BEFORE it creates anything, so an operator's own templates fail at setup rather than
     silently. To fix one, end the namespace with a letter (`…-pr{{pullNumber}}`), or spell the
     address with the separator the prefix does NOT join on (`…-5.127-0-0-1.nip.io`, or
     `…-5-127.0.0.1.nip.io`), since a four-octet run must use one separator throughout. Writing
     the address with dashes is not on its own a fix: a dashed prefix extends a dashed address
     exactly as a dotted one extends a dotted address.

     A host port other than the scheme's default goes in the URL source's own **`port`** field,
     never inside `hostTemplate`. The rendered template is also the Ingress `spec.rules[].host`
     your manifests declare, and Kubernetes rejects a `host` carrying a port, so a template like
     `{{namespace}}.127.0.0.1.nip.io:18080` yields the right environment URL and a manifest the
     apiserver refuses. Build the host from **`{{namespace}}`** rather than `{{branch}}` for a
     second reason: a branch is `cat-factory/<taskId>`, and the `/` ends the host and turns the
     rest into a path, so the URL names the bare `cat-factory` and the Ingress declaring that
     `host` is refused. `{{namespace}}` is already sanitized to one RFC1123 label.
     The **`manifestSource`** is no longer on this connection: it is declared per-service on the
     block's `provisioning` (colocated path or a separate repo), and merged with this engine config
     at provision time. In local mode you can additionally set a per-user "this-machine" override of
     the handler.

A loopback environment URL is reachable from your browser and from a NATIVE agent
(`LOCAL_NATIVE_AGENTS`) because loopback is the machine the ingress port is published on. It is not
reachable from an agent CONTAINER, whose `127.0.0.1` is its own network namespace, and the symptom
is a total connection failure that reads as a dead environment. The local facade handles this for
you: it maps the environment's host to the container's host gateway (`--add-host`), so the same URL
means the right thing in both places and the `Host` header ingress routes on stays correct. Nothing
to configure, and nothing is mapped for an environment that is genuinely remote. The one visible
consequence is that the tester's container is REPLACED rather than reused, because an `/etc/hosts`
entry is fixed when a container is created and the run's container predates its environment.

Local mode widens the environment URL-safety policy by default (`ENVIRONMENTS_ALLOW_HTTP_URLS`
plus a loopback/LAN `ENVIRONMENTS_ALLOW_URL_HOSTS` allow-list: `localhost`, `127.0.0.1`,
`host.docker.internal`, `.localhost`, `.local`, `.nip.io`, `.sslip.io`) so the `http://localhost`
/ ingress-host URL the provider returns is accepted. Add more hosts via
`ENVIRONMENTS_ALLOW_URL_HOSTS`. Hosted facades keep the strict public-https default.

### Networking from WSL2 (Windows)

> For the **Windows host toolchain** (installing native `kubectl`/`helm`/`kustomize`/`k3d` and
> bringing up a local k3d cluster: the simpler alternative to a WSL2 k3s), see
> [Set Up a Local Kubernetes Cluster on Windows](https://www.catfactory.ai/deploy/kubernetes-windows.html),
> with [`local-kubernetes-setup-windows.md`](./local-kubernetes-setup-windows.md) for wiring that
> cluster into the integration suites. The notes below apply specifically to running k3s **inside**
> a WSL2 distro.

On Windows, k3s runs inside a WSL2 distro (e.g. Ubuntu), not natively. Two facts make this work
with no port-forwarding layer:

- **WSL2 localhost-forwarding bridges Windows → WSL.** The k3s apiserver binds `0.0.0.0:6443`,
  so `https://127.0.0.1:6443` reaches it from BOTH inside WSL and from a Windows-host process:
  no `netsh portproxy` / `.wslconfig` change needed. Always use `127.0.0.1` / `localhost`, never
  the WSL `eth0` address (the `172.x` NAT IP is reassigned on every reboot).
- **Where you run `local-server` matters for the RUNNER path** (see below): running it _inside_
  WSL (the same distro as k3s) keeps the executor-pod → host-proxy callback to a single hop.
  Running it on the Windows host instead adds a pod → WSL → Windows-gateway hop plus a Windows
  Firewall inbound rule, so prefer WSL for the runner backend. For _environments_ it makes no
  difference: provisioning only needs outbound HTTPS to `:6443`.

### ServiceAccount, RBAC, and token

Both backends authenticate with a ServiceAccount bearer token. Apply this once: it covers the
runner Role + a long-lived token; uncomment the `ClusterRoleBinding` to add the cluster-wide
grant the ephemeral-ENVIRONMENTS backend needs to create per-PR namespaces:

```yaml
# k3s-cat-factory-rbac.yaml - kubectl apply -f k3s-cat-factory-rbac.yaml
apiVersion: v1
kind: Namespace
metadata: { name: cat-factory }
---
apiVersion: v1
kind: ServiceAccount
metadata: { name: cat-factory, namespace: cat-factory }
---
# Runner backend: manage run pods + reach the in-pod harness via the apiserver pod-proxy.
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata: { name: cat-factory-runner, namespace: cat-factory }
rules:
  - apiGroups: ['']
    resources: ['pods']
    verbs: ['create', 'get', 'list', 'delete']
  - apiGroups: ['']
    resources: ['pods/proxy']
    verbs: ['create', 'get']
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata: { name: cat-factory-runner, namespace: cat-factory }
roleRef: { apiGroup: rbac.authorization.k8s.io, kind: Role, name: cat-factory-runner }
subjects:
  - { kind: ServiceAccount, name: cat-factory, namespace: cat-factory }
---
# Long-lived SA token (k8s >= 1.24 no longer auto-creates one).
apiVersion: v1
kind: Secret
metadata:
  name: cat-factory-token
  namespace: cat-factory
  annotations: { kubernetes.io/service-account.name: cat-factory }
type: kubernetes.io/service-account-token
---
# Ephemeral ENVIRONMENTS also create namespaces + apply resources cluster-wide. For a throwaway
# local cluster the simplest grant is cluster-admin (drop this block if you only use the runner
# backend, or replace cluster-admin with a least-privilege ClusterRole over the manifest kinds):
# apiVersion: rbac.authorization.k8s.io/v1
# kind: ClusterRoleBinding
# metadata: { name: cat-factory-env-admin }
# roleRef: { apiGroup: rbac.authorization.k8s.io, kind: ClusterRole, name: cluster-admin }
# subjects:
#   - { kind: ServiceAccount, name: cat-factory, namespace: cat-factory }
```

Read the token (paste into the connection's `apiToken`):

```bash
kubectl -n cat-factory get secret cat-factory-token -o jsonpath='{.data.token}' | base64 -d; echo
```

Paste it as ONE line, and don't skip the `base64 -d`. Both mistakes are invisible in a password
field and were previously indistinguishable from a wrong token: a value copied across a wrapped
terminal line carries a newline no HTTP header can carry, and the raw `.data.token` is still
base64. The connect form now flags both on the field itself (the newline blocks Test/Save; the
other two shapes are overrulable warnings, since a `--token-auth-file` apiserver accepts arbitrary
static tokens), and `KubernetesApiClient` refuses the newline case before it ever dials.

The preset uses `insecureSkipTlsVerify`, so a CA is optional locally. To pin TLS instead, read
the cluster CA into `caCertPem`:

```bash
kubectl config view --raw --minify -o jsonpath='{.clusters[0].cluster.certificate-authority-data}' | base64 -d
```

## Registry credentials for a throwaway cluster

Operating this is on the website
([Deploy on Kubernetes](https://www.catfactory.ai/deploy/kubernetes.html#pulling-a-private-image-on-a-local-cluster));
what follows is why it is shaped this way.

A per-PR namespace is minted seconds before the manifests are applied, so a pull secret cannot be
waiting in it, and a private package answers 403 for the whole life of the environment. The
credential that fixes it is already in hand: every provision resolves a short-lived git token to
clone the manifests repo (`ProvisionEnvironmentRequest.clone`), and that same token authenticates
against the VCS host's own registry. So `ensureRegistryAuth` writes it into the namespace as a
`dockerconfigjson` Secret and attaches it to the service accounts, and nothing is configured,
asked for, or stored.

Five decisions in it are worth keeping:

- **The gate is the APISERVER naming THIS MACHINE, not the handler's declared engine.** A
  public-API caller cannot choose between `local-k3s` and `remote-kubernetes` (`KUBERNETES_ENGINE`
  in `PublicProvisioningController` pins every API-registered connection to the remote name, and
  that split is deliberately not a public fact), so gating on the engine would give two
  identically-configured clusters different behaviour depending on which door connected them, and
  would miss the acceptance suite entirely. The test is kernel's `isLocalMachineHost`, which is
  wider than loopback and narrower than private: it covers the spellings a local kubeconfig
  actually contains (`127.0.0.1`, `localhost`, `::1`, k3d's wildcard `0.0.0.0`, Docker Desktop's
  `kubernetes.docker.internal` and `host.docker.internal`) and refuses RFC1918, because a shared
  staging cluster on 10.x is somebody else's machine however private its address. The CLI's own
  `looksLocalCluster` composes the same predicate: the two were separate lists once, and the copy
  missing `0.0.0.0` withheld the whole behaviour from k3d's default kubeconfig.
- **A different FIELD MANAGER for what this owns, and NO second manager on what the manifests
  own.** Server-side apply treats each apply from one manager as that manager's complete desired
  state, so the Secret and the `default`-account patch go in under
  `REGISTRY_AUTH_FIELD_MANAGER`, out of reach of the manifests' own applies. That does not extend
  to an account the manifests DECLARE: `ServiceAccount.imagePullSecrets` is an ATOMIC list, which
  one manager owns whole, so a patch beside their apply is a race that `force=true` settles for
  whoever writes last, silently, and only on manifests that declare their own account. Such an
  account instead has the entry folded into the manifests' own body before it is applied
  (`withPullSecretOnServiceAccounts`), preserving whatever pull secrets it already declared, and
  `serviceAccountsNeedingOwnPatch` subtracts it from what gets patched separately.
- **Before the workloads, and covering the accounts they NAME.** The ServiceAccount admission
  controller copies an account's `imagePullSecrets` onto a pod when the pod is CREATED, so an
  account patched after its Deployment applied does not reach the pods already admitted. A
  workload setting `serviceAccountName` never reads `default`, so attaching only there would miss
  exactly the manifests that bothered to have an identity; a CronJob hides its own under
  `spec.jobTemplate.spec.template.spec`, where it fails on the first schedule rather than at
  provision time.
- **Best-effort, and never silent.** A deployment whose packages are already public pulls fine
  without any of this, so a refused write must not fail a provision that would otherwise succeed.
  Every outcome (wired, skipped and why, failed and why) goes to the provisioning log as a
  `registry-auth` step, because an unauthenticated pull and a private package look identical right
  up until the 403. "No credential" is FIVE distinct verdicts, not one, because each sends a
  reader at a different fix: no image names a registry, no clone target, a clone with no token (a
  public manifests repo), a registry the git host does not serve, and a remote cluster.
- **The credential is not renewed.** It is the provision's own short-lived git token, so it lasts
  about an hour, and the Secret keeps the value it was written with. Every pull inside that window
  works; a later one (a rollout, a scale-up, a reschedule onto a node with no cached layer)
  re-enters `ImagePullBackOff` with no new log entry, because nothing ran. Re-provisioning rewrites
  it. Renewing would need something outliving the provision, a controller in the cluster or a
  sweep over every live environment, which is a lot of machinery for a throwaway preview whose
  images are pulled once at rollout; the window is NAMED in the recorded step instead.

The container-render path (`buildProvisionJob`, hence its `Promise` return) does the same over the
apiserver before dispatch, and reaches only `default`: the manifests render inside the container,
so the accounts they declare cannot be enumerated. The recorded step says so rather than implying
the coverage the raw path gets. That path also has a case where it does nothing at all: a
kustomize overlay with no `namespaceTemplate` keeps its OWN namespace, which the harness reads
back from the built manifests inside the container (`deployTargetsBackendNamespace` is the shared
answer, and `setNamespace` derives from it). The destination is genuinely unknown before dispatch,
so writing anyway would create an empty namespace nothing tears down and put the credential where
no pod reads it, under a log line reporting success. It records the reason and skips. What the
credential cannot supply on any path is SCOPE, which is the one remaining way a pull fails: the
token needs package-read rights on its provider.

## Running AGENTS on a local k3s (runner backend)

The same cluster can also back the **agent runner** (not just Tester environments): connect a
native `kubernetes` runner backend so each agent run is a pod in the cluster. Local mode
surfaces a one-click **Local Kubernetes (k3s)** preset for this in the Infrastructure window's
"Agent containers" list: it prefills the runner form for a local cluster
(`apiServerUrl: https://127.0.0.1:6443`, `namespace: cat-factory`, `insecureSkipTlsVerify`, and
the executor `image` from the deployment's `LOCAL_HARNESS_IMAGE`), so the operator only pastes a
ServiceAccount token. No backend change is needed: the apiserver-URL validator already permits
loopback/private hosts (it only requires `https` and blocks the cloud-metadata endpoint), and
Node/local honors `insecureSkipTlsVerify`/`caCertPem` via undici. The token needs RBAC to
create/get/delete `pods` and `pods/proxy` in the namespace.

**The executor pod must reach this service's LLM proxy, and the local-mode default `PUBLIC_URL`
does NOT resolve from inside a k3s pod.** The Docker per-run transport injects
`--add-host=host.docker.internal:host-gateway`, so `PUBLIC_URL`'s default
(`http://host.docker.internal:<port>`) works there, but a k3s pod runs in the cluster network
namespace, where `host.docker.internal` is undefined, so the harness's `${PUBLIC_URL}/v1` model
calls would fail DNS. Set `PUBLIC_URL` explicitly to an address the pod can reach the host-run
proxy on:

- **`local-server` in WSL (recommended):** the pod reaches the host via the node IP. Point
  `PUBLIC_URL` at the WSL host's `eth0` address, e.g.
  `PUBLIC_URL=http://$(ip -4 -o addr show eth0 | awk '{print $4}' | cut -d/ -f1):8787`. Since
  that NAT IP changes across reboots, either re-resolve it on each start or pin a stable
  in-cluster name with a headless `Service` + manual `Endpoints` pointing at the host IP.
- **`local-server` on the Windows host:** the pod reaches Windows through the WSL gateway
  (`http://<wsl-gateway-ip>:8787`: the `eth0` default-route address, e.g. `172.x.x.1`). You
  must also open that port inbound in Windows Firewall and ensure `local-server` binds all
  interfaces (the local default). This is the fiddlier path: prefer running `local-server` in
  WSL.

This applies only to the **runner** backend; Tester **environments** never call back to the
proxy, so they need none of it.

## Future: managed local k3s lifecycle

The **guided one-shot setup** described above (`cat-factory k3s`) already provisions a cluster and
mints/wires credentials on demand. What is still future is having local mode **own the cluster's
ongoing lifecycle**: a cluster adapter analogous to the per-run `ContainerRuntimeAdapter`
(`runtimes/local/src/runtimes/*`). Sketch of what that needs:

- **Bring-up / tear-down**: create a k3s cluster on demand (k3d `cluster create`, or k3s in a
  container), and delete it (or stop it) when idle. Selected via a `LOCAL_K8S_RUNTIME` env knob
  (`k3d` | `none`), mirroring `LOCAL_CONTAINER_RUNTIME`.
- **Credentials**: read the generated kubeconfig, mint/extract a ServiceAccount token + the
  cluster CA, and seed the workspace's `kubernetes` connection automatically (a `linkCluster`
  helper, analogous to local mode's `linkRepo`).
- **Image loading**: a local image the PR built must be importable into the cluster (`k3d image
import`) rather than pulled from a registry; wire the provision flow to load `{{image}}` when
  it's a local tag.
- **URL exposure**: settled for the guided path (`cat-factory k3s` publishes the host port at
  cluster-create time and probes both halves before promising a template; see above). What is
  still open here is the MANAGED-lifecycle version: a cluster the local backend brings up itself
  has to make the same two guarantees, and has to pick the host port without an operator flag.
- **Isolation between concurrent runs**: per-PR namespaces already isolate within one cluster;
  decide whether concurrent runs share one managed cluster (cheaper) or get one each (stronger).
- **Open questions**: cluster reuse vs per-run; how long an idle managed cluster lives before the
  sweeper tears it down; surfacing bring-up progress/errors in the run UI.

This is design-only; no code ships for the managed lifecycle yet.
