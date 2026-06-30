# @cat-factory/deploy-harness

The container payload for the **container-backed Kubernetes deploy adapter**. It renders
a service's manifests with real `kubectl` / `kustomize` / `helm` and applies them into a
per-PR namespace — the work the native in-Worker REST adapter cannot do (that path only
applies raw, already-rendered manifests; a kustomize `secretGenerator` rewrites a
content-hashed Secret name into every reference at build time, and helm is infeasible to
render in-process).

Private (not published to npm). Its multi-arch Docker image is the deploy-time artifact;
the package `version` is the image tag (same discipline as `@cat-factory/executor-harness`).

## Contract

Identical shape to the executor harness, so the same `RunnerTransport` drives both:

- `GET /health` → `{ status: 'ok' }`.
- `POST /jobs` with a body whose `kind` is `deploy` → starts a background job, returns
  `202 { jobId, state }`. Idempotent: a re-dispatch re-attaches to the running job.
- `GET /jobs/{id}` → the live job view (`state`, `phase`, and on completion `result`).

Optional inbound auth via `HARNESS_SHARED_SECRET` + the `x-harness-secret` header
(constant-time compared), exactly as the executor harness.

The job body (`src/job.ts`) is built by the backend's
`KubernetesEnvironmentProvider.buildProvisionJob` (provision-types slice 8). Every
templated / secret value arrives **already resolved** — the harness never sees the
workspace secret bundle. It carries:

- `cluster` — apiserver URL + CA + bearer token + the resolved namespace.
- `source` — git clone URL + ref + overlay/file path + `renderer` (`raw` | `kustomize`).
- `images` / `helmReleases` / `secretInjections` — resolved kustomize image overrides,
  helm releases, and Secret / `generatorEnvFile` injections.
- `url` — how to discover the env URL once applied (Gateway / HTTPRoute / Service /
  Ingress status).

## Flow (`src/deploy.ts`)

`clone → ensure namespace → write secrets → kustomize edits (namespace / images) →
shared helm → kubectl apply (-k | -f) → per-env helm → kubectl rollout status → URL
discovery`. The job reports its coarse phase for the polled view and returns a
structured `DeployOutcome` (`namespace`, `url`, `status`) on the result's `custom`
channel, which the backend maps into a `ProvisionedEnvironment`.

## Build & publish

```sh
pnpm --filter @cat-factory/deploy-harness run build       # tsc → dist/
pnpm --filter @cat-factory/deploy-harness run image:publish  # multi-arch → GHCR + Docker Hub
```

Bump the package `version` (and the deployment's pinned image tag) whenever you change
`src/**`, the `Dockerfile`, `tsconfig.json`, or the pinned CLI versions — a fresh,
immutable tag is what forces the rollout (see CLAUDE.md).
