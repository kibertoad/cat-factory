---
'@cat-factory/contracts': minor
'@cat-factory/integrations': minor
'@cat-factory/server': minor
'@cat-factory/app': minor
---

Per-service provision types (slice 11): auto-detect a recommended Kubernetes provisioning
config from a service's repo.

A deterministic, pure-TS heuristic detector reads a service's repo checkout-free over the
`RepoFiles` port and proposes a NON-BINDING recommended provisioning config. High-confidence
facts are inferred deterministically (renderer from a `kustomization.yaml`; the URL source from
the manifest kinds — `Ingress`/`Gateway`/`HTTPRoute`/`LoadBalancer Service`; a pinned namespace;
`generatorEnvFile` secret injections with keys read from a `.env.example`; image overrides
defaulting the tag to `{{branch}}`); ambiguous ones (which `overlays/*` is the ephemeral one,
helm releases from a `helmfile.yaml`/`Chart.yaml`) are surfaced as candidates with a hint
rather than guessed. The user always confirms/edits — nothing is applied silently.

- Contracts: `provisioningRecommendationSchema` + `detectServiceProvisioningSchema` +
  `detectServiceProvisioningContract` (`POST /workspaces/:ws/environments/detect-provisioning`).
- `EnvironmentConnectionService.detectServiceProvisioning` runs the detector over the
  workspace-bound `RepoFiles`; new `provision-detect.logic.ts` with unit tests.
- Frontend: a "Detect from repo" affordance in the service inspector's test-infra section that
  prefills `block.provisioning` + surfaces the per-field confidence notes, overlay candidates,
  and engine-level URL/namespace suggestions; new i18n keys across all 8 locales.

No migration (detection is pure repo introspection — nothing persisted).
