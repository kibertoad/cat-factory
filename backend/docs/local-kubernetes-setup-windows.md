# Local Kubernetes provisioning on Windows (toolchain + k3d cluster)

How to get a working Kubernetes provisioning setup on a **Windows host** so the CLIs
(`kubectl` / `helm` / `kustomize`) run natively and a local **k3d** (k3s-in-Docker) cluster
backs the Kubernetes integration suites and local-mode environment/runner provisioning.

This is the **host-toolchain** companion to [`local-k3s-environments.md`](./local-k3s-environments.md)
(which covers pointing the product at a cluster) and to [`kubernetes-topology.md`](./kubernetes-topology.md).
The cluster tooling and versions here mirror what CI's `test-k8s` job and the
[`deploy-harness` Dockerfile](../internal/deploy-harness/Dockerfile) use, so the behaviour you
exercise locally matches what ships.

> **Why k3d, not k3s directly?** k3s is Linux-only — it does not run natively on Windows. k3d
> runs a real k3s cluster **inside Docker**, which on Windows means Docker Desktop. This is the
> same approach CI uses (`Test k8s (k3d)`), and it avoids needing a WSL2 k3s install. (Pointing
> at a k3s running inside WSL2 is still supported — see `local-k3s-environments.md` — but k3d on
> Docker Desktop is the simpler path and what this guide installs.)

## Prerequisites

- **Docker Desktop**, running (the k3s nodes are Docker containers). Verify: `docker version`.
- A package manager is optional — the steps below download pinned release binaries directly so
  no admin/UAC is required and you get the **exact** versions the harness pins. (Chocolatey/
  winget also work but lag the pinned versions and `choco install` needs elevation.)

## Pinned tool versions

These match the [`deploy-harness` Dockerfile](../internal/deploy-harness/Dockerfile) pins (the
image the deploy step actually runs), so local runs reproduce CI/container behaviour:

| Tool      | Version    | Notes                                                            |
| --------- | ---------- | ---------------------------------------------------------------- |
| kubectl   | `v1.36.2`  | Docker Desktop ships its own (older) kubectl — see PATH note.    |
| kustomize | `v5.8.1`   | Standalone; `kubectl` also bundles a `kustomize` subcommand.     |
| helm      | `v4.2.2`   |                                                                  |
| k3d       | `v5.9.0`   | Runs k3s in Docker; ships the klipper ServiceLB (LoadBalancer URLs resolve). |

> Bump these deliberately and in lockstep with the deploy-harness Dockerfile / the CI
> `test-k8s` job when the pinned versions move (see CLAUDE.md / CONTRIBUTING).

## Install the CLIs (no admin required)

Run in PowerShell. This downloads the pinned binaries into a per-user `bin` directory and adds
it to your **user** PATH — no elevation, nothing written to `Program Files`.

```powershell
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'                       # faster Invoke-WebRequest
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$bin = Join-Path $env:USERPROFILE 'bin'
New-Item -ItemType Directory -Force -Path $bin | Out-Null
$tmp = Join-Path $env:TEMP 'k8s-dl'
New-Item -ItemType Directory -Force -Path $tmp | Out-Null

# kubectl v1.36.2 (single exe)
Invoke-WebRequest 'https://dl.k8s.io/release/v1.36.2/bin/windows/amd64/kubectl.exe' -OutFile "$bin\kubectl.exe"

# k3d v5.9.0 (single exe, renamed)
Invoke-WebRequest 'https://github.com/k3d-io/k3d/releases/download/v5.9.0/k3d-windows-amd64.exe' -OutFile "$bin\k3d.exe"

# kustomize v5.8.1 (Windows asset is a .zip — note the Linux Dockerfile uses .tar.gz)
Invoke-WebRequest 'https://github.com/kubernetes-sigs/kustomize/releases/download/kustomize/v5.8.1/kustomize_v5.8.1_windows_amd64.zip' -OutFile "$tmp\kustomize.zip"
Expand-Archive "$tmp\kustomize.zip" -DestinationPath "$tmp\kustomize" -Force
Move-Item "$tmp\kustomize\kustomize.exe" "$bin\kustomize.exe" -Force

# helm v4.2.2 (.zip contains windows-amd64\helm.exe)
Invoke-WebRequest 'https://get.helm.sh/helm-v4.2.2-windows-amd64.zip' -OutFile "$tmp\helm.zip"
Expand-Archive "$tmp\helm.zip" -DestinationPath "$tmp\helm" -Force
Move-Item "$tmp\helm\windows-amd64\helm.exe" "$bin\helm.exe" -Force

# Add the bin dir to the USER PATH (persistent; no admin). Skips if already present.
$userPath = [Environment]::GetEnvironmentVariable('Path','User')
if (($userPath -split ';') -notcontains $bin) {
  [Environment]::SetEnvironmentVariable('Path', "$userPath;$bin", 'User')
}
```

> On **arm64** Windows, swap `amd64` → `arm64` in the URLs (all four publish arm64 builds; the
> helm/kustomize archive inner paths become `windows-arm64`).

Open a **new** terminal (so the PATH change takes effect) and verify:

```powershell
kubectl version --client   # Client Version: v1.36.2 ; Kustomize Version: v5.7.1 (bundled)
kustomize version          # v5.8.1
helm version --short       # v4.2.2+g...
k3d version                # k3d version v5.9.0
```

### PATH note: Docker Desktop's bundled kubectl

Docker Desktop installs its own `kubectl` (today `v1.34.1`) under
`C:\Program Files\Docker\Docker\resources\bin`, which is on the **machine** PATH. Windows
searches the machine PATH **before** the user PATH, so in a fresh shell a bare `kubectl` may
resolve to Docker's older client rather than the `v1.36.2` installed above. Both drive a k3d
cluster fine (a one-minor-version-older client is compatible), so this is usually harmless. If
you want the pinned `v1.36.2` to win, either:

- call it explicitly: `& "$env:USERPROFILE\bin\kubectl.exe" ...`, or
- prepend the bin dir for the session: `$env:Path = "$env:USERPROFILE\bin;$env:Path"`, or
- (admin) move `%USERPROFILE%\bin` ahead of the Docker entry in the **machine** PATH.
`helm`, `kustomize`, and `k3d` have no such conflict — Docker Desktop ships none of them.

## Bring up a local k3d cluster

```powershell
# A single-server cluster. --no-lb / disabling traefik frees port 80 for test workloads,
# matching CI; drop those flags if you want the built-in ingress + load balancer.
k3d cluster create cf-local --servers 1 --api-port 127.0.0.1:6443 `
  --k3s-arg "--disable=traefik@server:*" --wait --timeout 180s

kubectl get nodes -o wide        # the k3d-cf-local-server-0 node should be Ready
```

`k3d cluster create` writes/merges your kubeconfig and sets the current context, so `kubectl`
and `helm` talk to the new cluster immediately. Tear it down with
`k3d cluster delete cf-local`.

> First create pulls the `rancher/k3s` + k3d helper images (~hundreds of MB) once; subsequent
> creates are fast.

## Wire the cluster into the integration suites (`K8S_IT_*`)

Both the Kubernetes suite (`@cat-factory/integrations`) and the deploy-harness suite
(`@cat-factory/deploy-harness`) read the live cluster connection from `K8S_IT_*` env vars (see
`backend/internal/deploy-harness/test/cluster.ts`) and **self-skip** when they're absent. Mint a
ServiceAccount + token and export the vars — the PowerShell equivalent of CI's `test-k8s` job:

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
cluster (mirroring CI's "Build + import test images" step), exported via `K8S_IT_RUNNER_IMAGE`:

```powershell
docker build -t cat-factory-mock-harness:it `
  backend/packages/integrations/src/modules/kubernetes/test-support/mock-harness
docker pull nginx:1.27-alpine
k3d image import cat-factory-mock-harness:it nginx:1.27-alpine -c cf-local
$env:K8S_IT_RUNNER_IMAGE = 'cat-factory-mock-harness:it'
```

> **Windows test caveat (CLAUDE.md):** the Cloudflare **worker** vitest suite does not run on
> Windows. The Kubernetes/deploy-harness integration suites here are pure Node + the CLIs, so
> they do run on Windows against a local k3d cluster.

## Pointing the product at the cluster (local mode)

Once the cluster is up, local mode (`@cat-factory/local-server`) can use it as a Tester
**environment** backend and/or the **agent runner** backend with no code change — connect a
native `kubernetes` backend (`apiServerUrl: https://127.0.0.1:6443`, the ServiceAccount token,
`insecureSkipTlsVerify` for a throwaway cluster). The RBAC manifest, the runner-callback /
`PUBLIC_URL` networking details, and the URL-safety knobs are documented in
[`local-k3s-environments.md`](./local-k3s-environments.md).
