# Initiative: modular-vue adoption (frontend modularity + co-evolution)

**Status:** analysis complete, recommendation: conditional GO · **Owner:** frontend · **Started:** 2026-07-18

> This is the durable source of truth for a multi-PR initiative. Read it first before picking up the next slice; update the checklist at the end of each PR. No code has landed yet; this document is the analysis outcome and the adoption plan.

## Goal & rationale

Two problems in `frontend/app` (`@cat-factory/app`), one library that addresses both, and a deliberate dual goal.

**Problem 1: the extensibility ceiling.** Everything pluggable in the SPA today is data-driven from the backend snapshot: custom agent kinds (`useAgentsStore().registerCustomKinds`), provider backend kinds, initiative presets, skills. A consumer deployment (`deploy/frontend` is a ~5-file `extends` shell) can rebrand, retheme, and override locale strings, but it cannot contribute _components_: a new step result view (`STEP_RESULT_VIEWS` in `panels/StepResultViewHost.vue` is a hardcoded record), a navbar or command-palette entry (`SideBar.vue` / `CommandBar.vue` are hand-written item lists), an inspector panel (`InspectorPanel.vue` switches on `block.level` with `v-if` sections), or a modal (`pages/index.vue` mounts ~50 of them by hand). A company wanting a proprietary frontend extension for its custom agents today has exactly one option: fork the layer. The backend solved the equivalent problem with public registries (`registerAgentKind`, `registerGate`, the [registry DI migration](./registry-di-migration.md)); the frontend has no counterpart.

**Problem 2: hand-rolled structure in the standardization targets.** The areas the platform keeps growing are each reinvented per feature:

- **Navigation.** `SideBar.vue` (439 lines) hardcodes every nav button behind per-item RBAC computeds; `CommandBar.vue` re-derives the same catalog and the same gating by hand; `BoardToolbar.vue` is a third hardcoded list. Adding one destination means editing all of them plus the `ui` store and `index.vue`.
- **Wizards.** There is no shared multi-step framework. `EnvironmentSetupWizard.vue` (675 lines) plus its dedicated 489-line store roll their own `STEP_ORDER`; `BootstrapModal.vue` (758 lines), the onboarding modals, and the credential flows each invent their own step tracking and header markup.
- **Detail panels.** `InspectorPanel.vue` (631 lines) is a level-switched monolith importing ~20 sub-panels; only `InspectorSection.vue` is shared structure.
- **Agent-run details.** The big result windows (`RequirementsReviewWindow` 1220, `TestReportWindow` 931, `AgentStepDetail` 913, `ObservabilityPanel` 740, `PipelineProgress` 695) share good primitives (`StepRunMeta`, `StepRestartControl`, the `useResultView` contract) but each duplicates its dialog chrome (Teleport, backdrop, header, close handling).

**The dual goal.** [modular-vue](https://github.com/kibertoad/modular-react) (`@modular-vue/*`, developed in the modular-react monorepo, local checkout at `C:\sources\modular-react`) is our own library, and this adoption is explicitly a co-evolution program: cat-factory gets a real module/registry/slot/journey architecture, and modular-vue gets the production-consumer pressure that matures it, the same role `docs/consumer-feedback-production-app.md` played for the React family. Improving the library is part of every slice, not a precondition to clear once.

## What modular-vue offers (the primitives this initiative uses)

- **Module descriptors + registry.** `defineModule({ id, version, navigation, slots, dynamicSlots, requires, entryPoints, ... })` describes a feature as a plain object; `createRegistry(config)` composes registered modules into an application manifest (navigation manifest, slots manifest, DI wiring), validating duplicate ids, missing dependencies, and semver `moduleCompat` ranges at resolve time.
- **Slots.** Named arrays concatenated across all modules; `dynamicSlots(deps)` factories plus a global `slotFilter` re-evaluate on state change (`recalculateSlots()`), which is exactly the shape of RBAC-gated nav/command items.
- **Journeys.** Typed, serializable multi-module workflows: entry/exit point contracts, transitions, back/rewind, pluggable persistence, URL sync (`useJourneySync`), and Vue mount adapters that host a journey outside route navigation (`@modular-vue/journeys`).
- **Remote capability manifests.** `RemoteModuleManifest` / `mergeRemoteManifests`: backend-delivered JSON drives slots and navigation, data only, no components over the wire. This is a formalized version of the `customAgentKinds` snapshot pattern cat-factory already hand-rolled.
- **DI between modules.** Registry-owned `stores` / `services` / `reactiveServices` buckets; modules declare `requires` / `optionalRequires` and consume via `createSharedComposables` (`useStore`, `useService`, `useSlots`, `useNavigation`).
- **Nuxt integration.** `@modular-vue/nuxt` installs the resolved manifest on the Nuxt app from a plugin. cat-factory is `ssr: false`, which is the binding's simple case (singleton registry, no per-request state).

Out of scope for this SPA: the route-centric surface (`createRoutes()`, route-driven zones) and the compositions engine (0.1.x). cat-factory is a single-route board app; the value here comes from registry, slots, journeys, remote manifests, and DI, all of which work for non-routed modules.

## Fit analysis

### Strong matches

| cat-factory pain                                                                              | modular-vue primitive                                     | Why it fits                                                                                                                                 |
| --------------------------------------------------------------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| SideBar / CommandBar / BoardToolbar triple-maintain the same item catalog and RBAC gating     | Navigation manifest + slots + `dynamicSlots`/`slotFilter` | One registry of nav/command contributions, rendered three ways; RBAC becomes a slot filter instead of per-item computeds                    |
| No shared wizard framework; every multi-step flow rolls its own                               | Journeys                                                  | Typed steps, back/rewind, persistence, and URL sync replace the per-wizard `STEP_ORDER` + bespoke store; mount adapters host them in modals |
| `customAgentKinds` merged by mutating the module-global `AGENT_BY_KIND` in `utils/catalog.ts` | Remote capability manifests                               | The same backend-data-drives-frontend pattern, but with a wire-safe contract, id de-duplication, and no global mutation                     |
| Consumer deployments cannot contribute components without forking                             | Registry-registered modules through the `extends` chain   | A deployment registers its own modules contributing result views, nav items, and panels; the layer stays unforked                           |
| Frontend has no counterpart to the backend registry philosophy                                | The registry itself                                       | Culturally consistent with the repo: this is the frontend analogue of the [registry DI migration](./registry-di-migration.md)               |

### Weak or neutral

- **Route-centric surface goes unused.** Modules here will mostly be non-routed (no `createRoutes`), and route-driven zones do not apply to a single-route board. Unused surface, not a blocker; if deep links ever become routes (see `global-search-and-deep-links.md`), the surface is waiting.
- **Compositions** (`@modular-frontend/compositions-engine` 0.1.x) are not needed for any target area. Excluded from scope.

### Known upstream gaps (the opening entries of the upstream backlog)

These are not static risks; per the co-evolution model below they are the first upstream work items, owned by this initiative.

1. **Pinia interop.** The `Store<T>` contract is zustand-shaped (`getState`/`setState`/`subscribe`); cat-factory has 70 Pinia stores. A thin adapter (Pinia `$state`/`$subscribe`/`$patch` behind the contract) is feasible and is already a tracked follow-up in the library (`docs/vue-support-tracker.md`, decision D3). Ship it upstream, not as a cat-factory shim.
2. **`@modular-vue/nuxt` maturity.** The binding is 0.1.0 experimental. cat-factory's `ssr: false` layer is its easy case, but "registry factory exposed through a Nuxt layer's `extends` chain so the consumer can contribute modules" is a consumer story the library has not exercised. Harden and document it upstream; graduate the package out of 0.x as part of slice 0/1.

### Adoption risks on the cat-factory side

- **Migration scale.** ~180 components (~49k lines), 70 stores. Big-bang restructure is a no-go; this plan is strangler-only, seam by seam, matching how every other migration in this repo runs.
- **i18n guards.** Typed message keys (`typedOptionsAndMessages`) plus the parity scripts gate CI against one shared catalog per locale. Internal modules keep their strings in the shared catalog; consumer extension modules ship their own locale JSON through the existing layer deep-merge, which already supports exactly this.
- **Thin test coverage.** 33 spec files, no component tests. Every slice needs e2e coverage (`data-testid` + live-push assertions per the e2e rules) before its refactor, not after.
- **Choke points stay out of scope.** `workspace.applySnapshot` (fans into ~20 stores) and `useWorkspaceStream.onMessage` (17-branch switch) are real coupling, but modularizing the event fan-out is a separate future initiative. Touching them here would balloon every slice.
- **Maintenance.** modular-vue is single-maintainer, but the maintainer is us; the usual third-party abandonment risk is instead a dogfooding feedback loop, which is precisely the point.

## Recommendation: conditional GO

Adopt modular-vue in `@cat-factory/app` as a phased strangler migration of the non-route primitives (registry, slots, journeys, remote manifests, DI). The conditions are about _how_, not _whether_:

1. **The co-evolution loop is honored every slice.** A gap found mid-slice is fixed upstream in modular-vue and the released improvement re-adopted before the slice closes. Local shims in cat-factory never outlive their slice; a slice with a lingering workaround is still open.
2. **Strangler-only.** Each slice converts one seam and leaves the rest untouched. No big-bang, no parallel rewrite.
3. **Route-module restructure and compositions are out of scope.** Revisit only if the app grows real routes.

## Target pattern

Two halves, both mandatory per slice.

### The cat-factory shape

- **Registry factory in the layer.** `@cat-factory/app` owns a registry factory that registers the first-party modules and resolves the manifest from a Nuxt plugin (`@modular-vue/nuxt`, or its runtime `installModularApp` directly until the module wrapper matures). `ssr: false` means a singleton registry is fine.
- **Consumer contribution seam.** A deployment extending the layer contributes its own modules through a well-known seam in the extends chain (the exact mechanism, config-referenced module list vs. consumer plugin, is a slice 0 decision and an upstream documentation deliverable). Extension modules are first-class: nav items, command entries, result views, panels.
- **First-party features become modules incrementally.** Each converted area (navigation, result views, wizards, inspector panels) is registered through the same seam the consumers use, dogfooding the extension story exactly the way `@cat-factory/gates` dogfoods `registerGate` on the backend.
- **Backend data keeps driving capability.** The snapshot's `customAgentKinds` (and future capability lists) arrive as remote capability manifests merged into slots, replacing the ad-hoc `AGENT_BY_KIND` mutation while keeping the "backend-only change lights up a new capability" property.

### The co-evolution loop (the per-slice working protocol)

For every slice:

1. **Adopt** the primitive in the slice's target area.
2. **Reflect**: write down what fit cleanly and what needed bending (in the slice's PR description and this tracker's checklist row).
3. **File upstream**: every bend becomes an issue or change in the modular-react repo: a new API, an ergonomics fix, a doc gap, missing Vue/Nuxt parity. Feedback lives in the upstream repo, not only in this tracker.
4. **Land and release** the upstream change (`@modular-vue/*` release).
5. **Re-adopt immediately**: bump to the released version in the same slice and delete any interim shim.

A slice is `done` only when cat-factory runs on the released upstream improvements. The checklist records upstream outcomes (issues, releases consumed) next to the cat-factory PRs so the co-evolution half of the work is as visible as the migration half.

## Per-slice checklist

| #   | Slice                        | Target                                                                                                                                                                | Expected upstream workstream                                                                                                                                         | Status | cat-factory PRs | Upstream outcomes |
| --- | ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | --------------- | ----------------- |
| 0   | Spike: registry in the layer | Registry factory + Nuxt plugin wired into `@cat-factory/app` behind zero behaviour change; consumer contribution seam decided and documented                          | Pinia store adapter; `@modular-vue/nuxt` hardening for the `ssr: false` layer case; the layer-extends consumer story documented                                      | todo   |                 |                   |
| 1   | Navigation (pilot)           | One nav/command manifest feeding `SideBar`, `CommandBar`, `BoardToolbar`; consumer-contributed items work end to end                                                  | RBAC-gated `dynamicSlots`/`slotFilter` ergonomics under Vue reactivity; command-palette slot patterns                                                                | todo   |                 |                   |
| 2   | Result views                 | `STEP_RESULT_VIEWS` registry-driven; consumer-registered result-view components; `customAgentKinds` as a remote capability manifest; `AGENT_BY_KIND` mutation removed | Remote-manifest x locally-registered-component pairing (backend data selects a consumer-registered view), a shape the remote-manifest guide currently stops short of | todo   |                 |                   |
| 3   | Wizards                      | Journey-based `EnvironmentSetupWizard` pilot, then `BootstrapModal` and onboarding flows                                                                              | Modal/tab-mounted journeys in Vue (mount adapters outside routes); Pinia-backed journey persistence                                                                  | todo   |                 |                   |
| 4   | Inspector panels             | Level/type-keyed panel registry replacing the `InspectorPanel.vue` `v-if` monolith                                                                                    | A zones-without-routes story: zone contributions keyed by app state instead of the active route (zones are route-driven today)                                       | todo   |                 |                   |
| 5   | Agent-run window chrome      | Shared dialog shell extracted; result windows become registered modules composing it                                                                                  | Whatever the shell extraction surfaces (likely slot/zone composition inside a single host component)                                                                 | todo   |                 |                   |

## Conventions & gotchas

- **No local shims outliving their slice.** The fix for a library gap goes upstream and is re-adopted before the slice closes; the tracker row records the release that closed it.
- **Feedback lives upstream.** File issues/PRs in the modular-react repo; this tracker only summarizes outcomes.
- **Version coordination.** The neutral `@modular-frontend/*` engine packages pin tight peer ranges, so an engine bump means coordinated releases of the dependent bindings; follow the versioning policy in the library's `docs/vue-support-tracker.md`.
- **i18n:** internal modules keep keys in the shared catalog (typed keys + parity gates stay intact); consumer extension modules ship locale JSON via the layer deep-merge. Never move first-party strings out of `i18n/locales/`.
- **e2e first.** Each slice adds `data-testid` coverage and live-push e2e specs for its target area before refactoring it, per the e2e conventions in `CLAUDE.md`.
- **No route modules.** Modules here are non-routed; do not introduce `createRoutes()` usage without a real routing initiative.
- **Leave the choke points alone.** `workspace.applySnapshot` and `useWorkspaceStream.onMessage` are out of scope until a dedicated event-fan-out initiative.
- **Changesets:** every slice touching `@cat-factory/app` needs a changeset; consumer-visible seam changes are minor bumps.

## Key file reference

- Extensibility seams today: `frontend/app/app/utils/catalog.ts`, `app/stores/agents.ts`, `app/stores/ui/resultViews.ts`, `app/components/panels/StepResultViewHost.vue`, `app/composables/useResultView.ts`, `app/components/panels/GenericStructuredResultView.vue`.
- Standardization targets: `app/components/layout/SideBar.vue`, `app/components/layout/CommandBar.vue`, `app/components/board/BoardToolbar.vue`, `app/components/environments/EnvironmentSetupWizard.vue`, `app/stores/environmentWizard.ts`, `app/components/bootstrap/BootstrapModal.vue`, `app/components/panels/InspectorPanel.vue`, `app/pages/index.vue`.
- Consumer side: `frontend/app/nuxt.config.ts`, `deploy/frontend/nuxt.config.ts`.
- Library (local checkout `C:\sources\modular-react`): `packages/frontend-core/src/types.ts` (module contract), `packages/frontend-core/src/slots.ts`, `packages/frontend-core/src/remote-manifest.ts`, `packages/vue-runtime/src/app.ts`, `packages/vue-nuxt/src/install.ts`, `packages/vue-journeys/`, `docs/framework-mode-nuxt.md`, `docs/remote-capability-manifests.md`, `docs/vue-support-tracker.md`.
