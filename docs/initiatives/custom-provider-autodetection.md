# Custom test-infrastructure provider autodetection

## Goal & rationale

The built-in provision types (`kubernetes`, `docker-compose`) have rich, checkout-free
autodetection (`provision-detect.logic.ts`) that proposes a non-binding config from a service's
repo. **Custom providers had none.** A `custom` manifest type could only declare a single
`defaultManifestPath`, and detection merely resolved that one path — so a company running its own
ephemeral-environment convention (e.g. a repo identified by a root deploy manifest plus a bring-up
script plus a compose stack under a `deploy/` directory) could not have the platform recognize it,
arbitrate which provider fits, or extract config from those files. Such a convention typically
carries config worth extracting too (the health port/path, the deploy command).

**End state:** a custom-provider package (kernel + contracts only) authors an autodetection hook
using reusable checkout-free primitives — including MULTI-FILE signatures — and the platform
arbitrates across registered providers and prefills an extracted config seed. The user always
confirms; nothing is applied silently.

## The target pattern (reference implementation)

- **Primitives** live in `@cat-factory/kernel` (`src/shared/manifest-probe.logic.ts`): a probe
  toolkit (`matchManifestSignature` / `firstPresent` / `allPresent` / `anyPresent` / `readYamlDoc`
  / `readYamlDocs` / `listFiles`) over the shared `BudgetedRepoScanner`, plus the authoring types
  `CustomManifestDetectionContext` / `CustomManifestDetection`.
- **The hook** is an optional `detect(ctx) => CustomManifestDetection | null` on
  `RegisteredCustomManifestType` (`integrations/.../custom-manifest-types.ts`).
- **The detector** lives in `custom-detect.logic.ts` (split out of `provision-detect.logic.ts` to
  keep each within its size budget): `detectCustomManifest` runs the selected type's hook (fallback
  to path-only), `detectCustomProviderAcrossTypes` arbitrates when none is selected, and
  `resolveCustomProvisioning` / `arbitrateCustomProviders` are the thin entry points the service
  (`EnvironmentConnectionService.detectServiceProvisioning`) calls for the custom branch + a
  last-resort arbitration after the k8s/compose sweep.
- **The worked example** is `@cat-factory/example-custom-agent`'s `detectStackDeployProvider` /
  `registerExampleStackDeployProvider` (`src/stack-deploy.ts`) — copy its shape.
- **Reference doc:** `backend/docs/per-service-provisioning.md` → "Custom-provider autodetection".

## Per-item status

| Item                                                                                                                      | Status | PR        |
| ------------------------------------------------------------------------------------------------------------------------- | ------ | --------- |
| Kernel manifest-probe primitives + detect types + `yaml` dep                                                              | done   | (this PR) |
| Contracts: `customConfigSeed` / `secondaryManifestPaths` / `detectedManifestTypeCandidates`                               | done   | (this PR) |
| `detect` hook on `RegisteredCustomManifestType`                                                                           | done   | (this PR) |
| Detector: hook-aware `detectCustomManifest` + `detectCustomProviderAcrossTypes`                                           | done   | (this PR) |
| Service: single-type + arbitration + last-resort wiring                                                                   | done   | (this PR) |
| Worked example (stack-deploy provider) + unit tests                                                                       | done   | (this PR) |
| Cross-runtime conformance assertion (detect endpoint)                                                                     | done   | (this PR) |
| Docs (per-service-provisioning, kernel AGENTS)                                                                            | done   | (this PR) |
| **Slice 2 — SPA:** prefill `customConfigSeed` + render `detectedManifestTypeCandidates` picker in `ServiceTestConfig.vue` | todo   | —         |

## Conventions & gotchas

- **One shared scanner across the arbitration sweep.** Pass the single `BudgetedRepoScanner` into
  every provider's hook (via `ctx.scanner`) so overlapping probes cost one read (no N+1). Never
  build a scanner per provider.
- **A hook that finds nothing must return `null`/`matched:false`**, not throw — arbitration skips
  it. A genuine READ fault (`scanner.readFault`) surfaces as a `RepoReadError` (→ actionable
  validation error), not a misleading "nothing found".
- **A provider manifest may be templated** and not parse as strict YAML — `readYamlDoc` degrades to
  `null`, so the config seed is best-effort while the signature match still stands. Author hooks to
  match on the SIGNATURE first, then extract config best-effort.
- **Types without a `detect` hook can't be arbitrated** (no signature); the selected-type path still
  falls back to `defaultManifestPath` resolution for them.
- **Keep the runtimes symmetric by construction:** registration is by reference on the app-owned
  `customManifestTypeRegistry` (`createBackendRegistries()`), so both facades pick it up with no
  per-facade code. The conformance assertion guards the wiring.
