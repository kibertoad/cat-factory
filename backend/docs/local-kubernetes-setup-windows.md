# Local Kubernetes on Windows: the toolchain the test suites need

> **Installing the CLIs and bringing up the cluster is on the website:**
> [Set Up a Local Kubernetes Cluster on Windows](https://www.catfactory.ai/deploy/kubernetes-windows.html).
> It owns why k3d rather than k3s, the no-admin PowerShell install, the Docker Desktop `kubectl`
> PATH collision, creating and deleting a `cf-local` cluster, and pointing the product at it
> through `cat-factory k3s`. This page is the part that only means something with this repository
> checked out: which versions CI pins and why, and how a local cluster is wired into the
> Kubernetes integration suites.

Companion to [`local-k3s-environments.md`](./local-k3s-environments.md) (pointing the product at a
cluster) and [`kubernetes-topology.md`](./kubernetes-topology.md) (what the runner backend does to
one).

## Pinned tool versions

The website's install steps name versions so the block is copy-pasteable. This table is the reason
those are the numbers: they track what the product actually runs, so a local run reproduces CI and
container behaviour rather than merely working.

| Tool      | Version   | Source of truth   | Notes                                                                        |
| --------- | --------- | ----------------- | ---------------------------------------------------------------------------- |
| kubectl   | `v1.36.3` | deploy-harness    | Docker Desktop ships its own, older, client on the machine PATH.             |
| kustomize | `v5.8.1`  | deploy-harness    | Standalone; `kubectl` also bundles a `kustomize` subcommand.                 |
| helm      | `v4.2.3`  | deploy-harness    |                                                                              |
| k3d       | `v5.7.5`  | CI `test-k8s` job | Runs k3s in Docker; ships the klipper ServiceLB (LoadBalancer URLs resolve). |

`kubectl` / `kustomize` / `helm` are the [`deploy-harness` Dockerfile](../internal/deploy-harness/Dockerfile)
pins, that image being what the deploy step actually runs. `k3d` is CI's, because the deploy-harness
applies manifests to an existing cluster and ships no k3d at all.

**Bumping one is two edits, and the website page is a third.** Move the pin at its source of truth,
move it here, and move the version in the install block on the website page, or a contributor
following it installs a client the suites were not exercised against.

## Wire the cluster into the integration suites (`K8S_IT_*`)

The Kubernetes suite (`@cat-factory/integrations`) and the deploy-harness suite
(`@cat-factory/deploy-harness`) read a live cluster connection from `K8S_IT_*` (see
`backend/internal/deploy-harness/test/cluster.ts`) and **self-skip** when it is absent. That is why
a green local run proves nothing until these are exported: the PowerShell below is CI's `test-k8s`
job, per line.

```powershell
$env:Path = "$env:USERPROFILE\bin;$env:Path"   # ensure the pinned kubectl for this session

kubectl create namespace cat-factory-it
kubectl create serviceaccount cat-factory-it -n cat-factory-it
# cluster-admin is fine for a throwaway local cluster (the env suite creates namespaces
# cluster-wide); narrow it for anything you keep around.
kubectl create clusterrolebinding cat-factory-it `
  --clusterrole=cluster-admin --serviceaccount=cat-factory-it:cat-factory-it

$env:K8S_IT_TOKEN     = kubectl create token cat-factory-it -n cat-factory-it --duration=3600s
$server               = kubectl config view --minify -o jsonpath='{.clusters[0].cluster.server}'
$env:K8S_IT_APISERVER = $server -replace '0\.0\.0\.0','127.0.0.1'
$env:K8S_IT_NAMESPACE = 'cat-factory-it'

# Trust the apiserver's self-signed TLS. Easiest for a throwaway cluster: skip verification.
$env:K8S_IT_INSECURE  = '1'
# Or pin the CA instead of skipping (decode the base64 kubeconfig CA to PEM):
# $caB64 = kubectl config view --minify --raw -o jsonpath='{.clusters[0].cluster.certificate-authority-data}'
# $env:K8S_IT_CA_PEM = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($caB64))
```

Then run the suites from the repo root (Turbo builds workspace deps first):

```powershell
# Kubernetes runner + environment backends against the real apiserver.
# The runner cases also need a mock-harness image imported into the cluster; see below.
pnpm --filter @cat-factory/integrations run test:integration

# deploy-harness handleDeploy with real kubectl/kustomize/helm.
pnpm --filter @cat-factory/deploy-harness run test:integration
```

The **runner** sub-suite additionally needs its mock-harness image built and imported into the
cluster, mirroring CI's "Build + import test images" step, and exported as `K8S_IT_RUNNER_IMAGE`. A
k3d cluster has its own image store: an image that exists on the Docker host is not visible to the
nodes until `k3d image import` puts it there.

```powershell
docker build -t cat-factory-mock-harness:it `
  backend/packages/integrations/src/modules/kubernetes/test-support/mock-harness
docker pull nginx:1.27-alpine
k3d image import cat-factory-mock-harness:it nginx:1.27-alpine -c cf-local
$env:K8S_IT_RUNNER_IMAGE = 'cat-factory-mock-harness:it'
```

> **Windows test caveat (CLAUDE.md):** the Cloudflare **worker** vitest suite does not run on
> Windows. These two suites are pure Node plus the CLIs, so they do run on Windows against a local
> k3d cluster, which is what makes the toolchain above worth installing.
