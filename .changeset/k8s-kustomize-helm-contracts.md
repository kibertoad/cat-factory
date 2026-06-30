---
'@cat-factory/kernel': minor
'@cat-factory/contracts': minor
---

Per-service provision types (Phase 2, slice 6 — Kustomize / Helm / Gateway-API contract +
port seam). Additive only; no migration (the new fields ride the existing `handler_json` /
service `provisioning` JSON columns).

Contracts (`@cat-factory/contracts` `environments.ts`):

- `kubernetesManifestSourceSchema` gains an optional `renderer: 'raw' | 'kustomize'` on both
  the `colocated` and `separate` members (absent ⇒ `raw`). `kustomize` marks an overlay
  directory that must be `kustomize build`-rendered before apply — handled only by the
  container-backed deploy adapter, not the in-Worker REST adapter.
- New schemas `kubernetesImageOverrideSchema` (structured `images:`-style overrides),
  `kubernetesHelmReleaseSchema` (+ `kubernetesHelmSetSchema`; pinned version,
  `scope: 'per-environment' | 'shared'`), and `kubernetesSecretInjectionSchema` (+
  `kubernetesSecretEntrySchema`; logical-key → `secretRef`/templated value mapping). The
  injection has two `mode`s: `secret` (materialize a `Secret` directly) and
  `generatorEnvFile` (write a `KEY=value` `.env` at `envFilePath` for an overlay's own
  `secretGenerator` to consume — the common dedicated-overlay ephemeral-env shape).
- These schemas ENFORCE their documented invariants rather than only describing them: a
  helm release `version` must be a pinned semver (floating tags like `latest`/`^1.0` are
  rejected); an image override must set at least one of name/tag/digest and may not set both
  a tag and a digest; a secret entry must set exactly one of `secretRef` or `valueTemplate`.
- `serviceProvisioningSchema` (the service "what/where") gains optional `images`,
  `helmReleases`, and `secretInjections`; `kubernetesEngineConfigSchema` (the workspace
  "how") gains optional `helmReleases` for cluster-singleton (`scope: 'shared'`) releases.
- `kubernetesUrlSourceSchema` gains `gatewayStatus` and `httpRouteStatus` variants for
  Gateway-API URL discovery (alongside the existing Ingress/Service sources).

Kernel port seam (`@cat-factory/kernel`):

- `RunnerDispatchKind` widens to `'agent' | 'deploy'`; `RunnerDispatchOptions.image` gains
  `'deploy'` (the separate deploy-harness image with `kubectl`/`kustomize`/`helm`).
- `EnvironmentProvider` gains an optional `asyncProvision` capability (`AsyncProvisionCapability`)
  that pairs `buildProvisionJob(req)` (return a container-backed `DeployProvisionJob` to dispatch
  - park on, or `null` for the synchronous path) with `finalizeProvision(view, req)` (map a
    finished deploy job into a `ProvisionedEnvironment`). The two are grouped into one member so the
    build⇒finalize invariant is type-enforced — a provider cannot supply one without the other.

The deploy-harness image, the provider implementation, the async deployer lifecycle, and the
facade wiring follow in later slices.
