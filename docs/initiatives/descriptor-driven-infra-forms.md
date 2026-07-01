# Descriptor-driven infrastructure connect forms

## Goal & rationale

The SPA must render the connect form for **every** infrastructure backend — the built-in
`kubernetes`, the opt-in `eks`, and any deployment-registered custom kind — from a
**backend-supplied descriptor**, so the UI is never aware of which optional backends exist and
a new backend ships with **zero frontend changes**. The end state: no hardcoded per-kind Vue
form components and no freeform JSON manifest editor — every field (params + secrets) is
described by the backend and rendered generically.

This mirrors the "native environment adapter" seam that already existed
([`backend/docs/native-environment-adapter.md`](../../backend/docs/native-environment-adapter.md)):
a provider self-describes its config via `ProviderConfigField[]`, and the SPA overlays flat
field values onto a stored template. The initiative extends that idea to the remaining
hardcoded surfaces.

## The target pattern (pilot — landed)

The **runner backend** axis is the reference implementation:

- A `RunnerBackendProvider` exposes an optional `form: RunnerBackendForm`
  (`backend/packages/integrations/src/modules/runners/runner-backends.ts`) with three inverse
  pieces: `fields()` (the flat `ProviderConfigField[]`), `skeleton()` (the empty
  `{ kind, <payload> }` config to overlay onto for a first connect), and `valuesFromConfig()`
  (invert a stored config → flat values for prefill).
- `RunnerPoolConnectionService.describeProvider` returns a `native` `ProviderDescriptor` with
  `configFields` + `configTemplate` (the stored config on edit, else the skeleton — so advanced
  API-only fields survive a re-save) + `values` (prefill).
- The SPA `ProviderConnectionTab.vue` renders the generic flat-field form for any descriptor
  carrying a `configTemplate`, overlaying values onto the single non-`kind` payload key and
  POSTing the existing `{ config, secrets }` — it never names a backend. Field types were
  extended (`number` / `checkbox` / `textarea`) so typed fields render without a bespoke form.
- The shared Kubernetes runner fields live once in `kubernetesLogic.KUBERNETES_RUNNER_FORM_FIELDS`;
  EKS reuses them and appends its AWS fields (`backend/packages/eks/src/eks-form.logic.ts`).

Result: the hardcoded `KubernetesRunnerForm.vue` was **deleted**; `kubernetes`, `eks`, and any
native custom runner backend all render from the descriptor.

## Per-item status checklist

| Surface                                                                              | Status | Notes / PR                                                                                                                                                       |
| ------------------------------------------------------------------------------------ | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runner axis: `kubernetes` descriptor-driven                                          | `done` | pilot — this PR                                                                                                                                                  |
| Runner axis: `eks` descriptor-driven (reachable, no hardcoding)                      | `done` | this PR                                                                                                                                                          |
| Runner axis: retire `KubernetesRunnerForm.vue`                                       | `done` | this PR                                                                                                                                                          |
| Field types `number`/`checkbox`/`textarea` in the generic form                       | `done` | this PR                                                                                                                                                          |
| Env axis: `KubernetesEnvironmentForm.vue` → descriptor-driven                        | `todo` | needs nested/union fields (manifest source + URL derivation) the flat `ProviderConfigField` can't yet express                                                    |
| Env axis: `KubernetesEngineForm.vue` (per-service infra handler) → descriptor-driven | `todo` | same union-field gap; engine-discriminated per-service path                                                                                                      |
| Env axis: surface `eks` as its own `InfraEngine('eks')`                              | `todo` | thread through the contract engine union + `handlerConfigToBackendConfig` + the per-provision-type SPA selector (called out in `backend/packages/eks/README.md`) |
| Retire the freeform JSON manifest editor (`ProviderManifestEditor.vue`)              | `todo` | needs a schema-derived structured form for arbitrary HTTP request-template manifests (nested objects + `statusMap` arrays) — a generic recursive field renderer  |

## Conventions & gotchas carried between iterations

- **Overlay onto the STORED config, not an empty skeleton, on edit.** The flat form only renders
  a subset of fields; advanced API-only keys (Kubernetes `resources`/`nodeSelector`/`tolerations`,
  etc.) must survive a re-save. `configTemplate` = stored config when connected.
- **Coerce typed fields at the overlay boundary.** The wire value is always a string; the SPA
  coerces `number`/`checkbox` to their JSON type before POSTing, and the backend Valibot-validates.
  A cleared field is dropped so it reverts to absent (not `""`).
- **The SPA reads the payload key off the skeleton** (the single non-`kind` key) — it must never
  hardcode `kubernetes`/`eks`. This is the invariant that keeps the UI provider-agnostic.
- **Field labels are backend-supplied English**, not i18n keys (the established `describeConfig`
  convention — the compose/HTTP providers do the same). Only the surrounding chrome is localized.
- **The env axis is genuinely harder**: its Kubernetes config has discriminated-union fields
  (manifest source `colocated`/`separate`; URL derivation `ingressTemplate`/`ingressStatus`/
  `serviceStatus`) that a flat `ProviderConfigField` list can't express. Extending the descriptor
  with grouped/conditional fields (or a small recursive schema-form generator) is the prerequisite
  for retiring both the env form and the JSON manifest editor — do that once and both fall out.
