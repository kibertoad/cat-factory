# Upstream request (modular-react / modular-vue): a Vue journeys binding (`@modular-vue/journeys`) — modal/tab-mounted journeys + Pinia persistence

**For:** the modular-react maintainers (`@modular-frontend/*` engine + `@modular-vue/*` bindings + `docs/`).
**From:** the cat-factory frontend team, driving [modular-vue adoption slice 3 ("Wizards")](./modular-vue-adoption.md).
**Type:** **new binding package** `@modular-vue/journeys` (the Vue analogue of `@modular-react/journeys@1.8.0`), plus small carry-over peer-range widens and a Pinia interop deliverable that was deferred from slice 0. Additive; no breaking changes to existing packages.
**Status:** ⛔ **REQUESTED — BLOCKING slice 3.** The neutral journey runtime (`@modular-frontend/journeys-engine@1.7.1`) and a complete React binding (`@modular-react/journeys@1.8.0`) both ship today, but **there is no Vue binding** — `@modular-vue/journeys`, `@modular-vue/vue-journeys`, and `@modular-vue/journey` all 404 on npm, and `@modular-vue/vue@1.1.0` exports no journey surface. cat-factory cannot host a journey in Vue without hand-rolling the outlet/host/provider/sync layer locally, which is precisely the "local shim that outlives its slice" the initiative forbids. This document is the co-evolution artifact for slice 3: the upstream half, written before the cat-factory half so the two land as a matched set.

> Self-contained by design — read it without cat-factory context. The initiative tracker's slice-3 row ("Expected upstream workstream: Modal/tab-mounted journeys in Vue (mount adapters outside routes); Pinia-backed journey persistence") points here. It mirrors the slice-2 spec ([`modular-vue-slice2-upstream-pairing.md`](./modular-vue-slice2-upstream-pairing.md)), which shipped essentially as written.

---

## 1. Context — the consumer pressure

cat-factory is a Nuxt SPA (`ssr: false`) adopting modular-vue as a phased strangler migration. Slices 0–2 landed: the registry factory in the layer (slice 0), a nav/command manifest on `useReactiveSlots` (slice 1), and a result-view registry + remote-capability pairing (slice 2). **Slice 3 converts the app's multi-step wizards to journeys.**

The app today has **no shared multi-step framework**. Every guided flow reinvents step tracking, header/crumb chrome, back/next gating, and reset-on-open:

- **`EnvironmentSetupWizard.vue`** (675 lines) + a dedicated **`environmentWizard.ts` Pinia store** (489 lines) — a real 4-step flow (`pick → review → preflight → save`) with a hand-rolled `STEP_ORDER`, a `step` ref, `goToStep`/`back`/`next`, per-step `data-testid` crumbs, and a large `resetFlowState()` that must be called on every open and every frame re-selection or stale state leaks across targets. This is the **slice-3 pilot**.
- **`BootstrapModal.vue`** (758 lines) — a mode-branched form (`reference` vs `scratch`) with its own inline field state.
- **Onboarding flows** — `AiProviderOnboardingModal.vue`, `GitHubOnboarding.vue`, and the credential-connect flows, each with bespoke step markup.

These are exactly the "typed steps, back/rewind, persistence, URL sync" shape journeys model. The initiative's fit analysis calls this out directly:

> | No shared wizard framework; every multi-step flow rolls its own | **Journeys** | Typed steps, back/rewind, persistence, and URL sync replace the per-wizard `STEP_ORDER` + bespoke store; mount adapters host them in modals |

Two properties matter for cat-factory specifically and drive the two named sub-requests (§4B, §4C):

1. **These wizards are hosted in modals, not routes.** cat-factory is a single-route board app (the "No route modules" convention is a hard initiative rule). A journey here is mounted inside a `UModal`, opened/closed by a `ui`-store boolean — **outside route navigation entirely.** The journey must run, advance, rewind, and finish without ever owning the URL. (Optional deep-linking, if we ever add it, would go through vue-router via a `JourneySyncPort` — but the baseline is no-URL modal hosting.)
2. **Journey state must survive a modal close/reopen and live in Pinia.** cat-factory's 70 stores are Pinia; the wizard's cross-step state is a Pinia store today. A journey's persistence adapter (and, per slice 0's deferred item, the `Store<T>` interop) should be Pinia-backed so the flow resumes where it left off and integrates with the existing store ecosystem rather than a parallel state mechanism.

## 2. What exists today, and exactly where it stops short

Current published versions (all installable):

| Package                               | Version     | Role                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@modular-frontend/journeys-engine`   | `1.7.1`     | **Framework-neutral journey runtime** — `createJourneyRuntime`, `defineJourney`, validation, persistence contracts + factories, `journeysPlugin`, authoring helpers, handles, types. Description: _"No UI-framework dependency — the outlet and hooks live in a binding package."_ Deps `@modular-frontend/core@0.1.0`.                                    |
| `@modular-react/journeys`             | `1.8.0`     | **Complete React binding** — `JourneyOutlet`, `JourneyHost`, `JourneyProvider`, `ModuleTab`, `useJourneyHost`, `useJourneySync`, `useJourneyState`/`useJourneyInstance`/`useJourneyContext`, `useActiveLeafJourney*`, `useWaitForExit`, `useJourneyCallStack`, `createJourneyMountAdapter`, plus a `./testing` entry. Re-exports the whole engine surface. |
| `@modular-vue/core` `/vue` `/runtime` | `1.1.0`     | Vue bindings for **modules, slots, navigation, DI** — `defineModule`, `useReactiveSlots`, `ModuleRoute`, `ModuleErrorBoundary`, `ModuleExitProvider`, `useModuleExit`, `resolveEntryComponent`, `preloadEntry`, …                                                                                                                                          |
| `@modular-vue/nuxt`                   | `0.1.1`     | Nuxt install — `installModularApp` / `buildModularPluginContents` (module + slots + nav + DI). **Journey-unaware.**                                                                                                                                                                                                                                        |
| `@modular-vue/compositions`           | `1.0.0`     | Vue compositions binding.                                                                                                                                                                                                                                                                                                                                  |
| `@modular-vue/testing`                | `1.0.1`     | Vue testing helpers.                                                                                                                                                                                                                                                                                                                                       |
| **`@modular-vue/journeys`**           | **— (404)** | **Does not exist.**                                                                                                                                                                                                                                                                                                                                        |

**The neutral runtime is done; the React binding is done; the Vue binding is simply absent.** Concretely:

### Gap A — no Vue host layer for journeys

`@modular-vue/vue@1.1.0` ships the **module**-hosting surface (`ModuleRoute`, `ModuleTab`-equivalent via `ModuleExitProvider`/`useModuleExit`, `ModuleErrorBoundary`) — the analogue of `@modular-react/react`. But it has **no journey surface at all**: no `JourneyOutlet` (render the current step), no `JourneyHost`/`useJourneyHost` (own the instance lifecycle: start on mount, abandon on unmount, resume when persisted), no `JourneyProvider`/`useJourneyContext` (thread the runtime through context), no `useJourneyState`/`useJourneyInstance` (tearing-free subscription to instance snapshots), no `useJourneySync` (URL reconciler wrapper), no `useWaitForExit`, no `createJourneyMountAdapter`. Every one of these exists in `@modular-react/journeys`; none exists for Vue.

Interestingly, the React binding's own docs already anticipate the Vue port — `useJourneyHost`'s JSDoc says _"The Vue binding resolves its runtime the same way, once at setup."_ The port is expected; it just hasn't been built.

### Gap B — no modal/tab mount story for Vue (journeys outside routes)

The React binding hosts journeys host-agnostically ("works in a tab, modal, route element, or plain `<div>`"), and `createJourneyMountAdapter` adapts a runtime to the neutral `RuntimeMountAdapter` for embedding. For Vue there is **nothing** — and cat-factory's baseline case is exactly "host a journey inside a modal, opened by a boolean, no URL involved." This is the tracker's named upstream item ("Modal/tab-mounted journeys in Vue (mount adapters outside routes)").

### Gap C — no Pinia-backed persistence, and the slice-0 `Store<T>` Pinia adapter is still deferred

The neutral engine ships `JourneyPersistence` (`keyFor`/`load`/`save`/`remove`) plus `createMemoryPersistence` and `createWebStoragePersistence`. There is **no Pinia-backed persistence adapter**, and no documented recipe for one. Separately, slice 0 deferred the **`Store<T>` Pinia adapter** (the zustand-shaped `getState`/`setState`/`subscribe` contract vs. Pinia's `$state`/`$subscribe`/`$patch`), tracked as decision D3 in the library's `docs/vue-support-tracker.md`. Slice 3 is where a Pinia store first meets journey persistence, so both come due here. This is the tracker's second named upstream item ("Pinia-backed journey persistence").

### Gap D — carry-over peer-range drift

Two version-alignment loose ends compound if not handled with this work:

- `@modular-frontend/journeys-engine@1.7.1` deps `@modular-frontend/core@0.1.0`, while the Vue family is on `@modular-frontend/core@0.2.0` (the slice-2 release). A Vue journeys binding pulling the engine must not drag a second, older `@modular-frontend/core` into the tree.
- The slice-2 residual (already noted in that spec's §Status): `@modular-vue/{vue,runtime,nuxt}` still peer-range `@modular-frontend/core@^0.1.0`; only `@modular-vue/core` widened to accept `0.2.0`. A new journeys binding should peer-range `^0.2.0` cleanly, and the existing three should be widened in the same release train.

## 3. Design principle — mirror the React binding, don't reinvent

The React binding is the reference implementation and the contract is framework-neutral (it all bottoms out in `@modular-frontend/journeys-engine`). The Vue binding should be a **faithful, idiomatic Vue port of `@modular-react/journeys@1.8.0`** — same names, same semantics, same runtime re-exports — differing only where Vue idiom demands (composables return `Ref`/`ComputedRef`; components are SFC/`defineComponent`; render-prop children become slots). This keeps the two families teachable from one mental model and lets the neutral docs stay shared.

## 4. Proposed upstream changes

### 4A. New package `@modular-vue/journeys` — the Vue journeys binding

Publish `@modular-vue/journeys` (initial `1.0.0`, or aligned to the family's current major), depending on `@modular-frontend/journeys-engine` (bumped to dep `@modular-frontend/core@^0.2.0` — see §4D) and peer-depending on `@modular-vue/core`/`@modular-vue/vue`/`vue`. It must:

**Re-export the full neutral engine surface** (so a Vue consumer never reaches past the binding — the exact principle established in slice 2's §3A): `createJourneyRuntime`, `defineJourney`, `defineJourneyHandle`, `defineJourneyPersistence`, `defineTransition`, `createMemoryPersistence`, `createWebStoragePersistence`, `createJourneySync`, `createMemoryJourneySyncPort`, `journeysPlugin`, `selectModule`/`selectModuleOrDefault`, `invoke`, `isTerminalSentinel`, `isJourneySystemAbort`, the validators, and all journey types (`JourneyDefinition`, `JourneyInstance`, `JourneyRuntime`, `JourneyHandle`, `JourneyPersistence`, `SerializedJourney`, `TerminalOutcome`, `JourneyStep`, `StepSpec`, …).

**Provide the Vue host surface** — the componentry + composables, Vue-idiomatic equivalents of the React binding:

```ts
// @modular-vue/journeys

// ── Rendering ────────────────────────────────────────────────────────────────
/** Renders the current step of a journey instance. Host-agnostic (modal/tab/div).
 *  Abandons the instance on unmount (deferred a microtask). Reads runtime from
 *  <JourneyProvider> context unless the `runtime` prop overrides it. Supports
 *  `leafOnly`, `retryLimit`, `notFoundComponent`/`errorComponent` (as slots or
 *  component props), `onFinished`, `onStepError`, `preload`. */
export const JourneyOutlet: DefineComponent<JourneyOutletProps>

// ── Lifecycle ────────────────────────────────────────────────────────────────
/** Own a journey instance for a component's lifetime: start on mount (which is
 *  RESUME when persistence is configured — returns the in-flight instance for the
 *  same keyFor(input)), abandon on unmount. Instance is FIXED for the component's
 *  lifetime; remount (`:key`) to run a different journey. Returns reactive
 *  { instanceId, instance, runtime, stepIndex }. Runtime resolved once at setup,
 *  from `options.runtime` or <JourneyProvider>. */
export function useJourneyHost<TInput>(
  handle: JourneyHandle<string, TInput, unknown>,
  input: MaybeRefOrGetter<TInput>,
  options?: { runtime?: JourneyRuntime },
): {
  instanceId: Ref<InstanceId | null>
  instance: Ref<JourneyInstance | null>
  runtime: JourneyRuntime
  stepIndex: Ref<number>
}

/** One-line host: starts on mount, renders the current step, abandons on unmount.
 *  Chrome (progress/title/cancel) via a scoped slot exposing { instanceId, instance,
 *  stepIndex, outlet }, mirroring the React render-prop child. `input` required iff
 *  the handle's TInput is not void. */
export const JourneyHost: DefineComponent<JourneyHostProps>

// ── Context ──────────────────────────────────────────────────────────────────
/** Provide the runtime (usually manifest.journeys) to descendant outlets; composes
 *  over ModuleExitProvider so ModuleTab/useModuleExit see the shell's onModuleExit. */
export const JourneyProvider: DefineComponent<JourneyProviderProps>
export function useJourneyContext(): JourneyProviderValue | null

// ── Instance subscription (tearing-free) ─────────────────────────────────────
export function useJourneyInstance(
  instanceId: MaybeRefOrGetter<InstanceId | null>,
): Ref<JourneyInstance | null>
export function useJourneyState<TState>(
  instanceId: MaybeRefOrGetter<InstanceId | null>,
): Ref<TState | null>
export function useActiveLeafJourneyInstance(
  rootId: MaybeRefOrGetter<InstanceId | null>,
): Ref<JourneyInstance | null>
export function useActiveLeafJourneyState<TState>(
  rootId: MaybeRefOrGetter<InstanceId | null>,
): Ref<TState | null>
export function useJourneyCallStack(
  runtime: JourneyRuntime,
  rootId: InstanceId,
): Ref<readonly InstanceId[]>

// ── Module-as-tab host (outside a journey) ───────────────────────────────────
/** Host a single module entry outside any route/journey — in a tab/modal/panel.
 *  (May reuse the existing @modular-vue/vue ModuleExit* primitives internally.) */
export const ModuleTab: DefineComponent<ModuleTabProps>

// ── URL sync (opt-in; see §4B) ───────────────────────────────────────────────
/** Vue lifetime wrapper around the neutral createJourneySync reconciler. No-op when
 *  instanceId is null. Router-neutral via a JourneySyncPort the caller supplies. */
export function useJourneySync(
  instanceId: MaybeRefOrGetter<InstanceId | null>,
  port: JourneySyncPort,
  options?: UseJourneySyncOptions & { runtime?: JourneyRuntime },
): void

// ── Exit waiting ─────────────────────────────────────────────────────────────
export function useWaitForExit<TExits extends ExitPointMap>(
  exit: ExitFn<TExits>,
  channels: WaitForExitChannels<TExits>,
): void

// ── Mount adapter (embedding; see §4B) ───────────────────────────────────────
export function createJourneyMountAdapter(runtime: JourneyRuntime): RuntimeMountAdapter
```

Semantics that must match the React binding exactly (these are the load-bearing ones cat-factory relies on):

- **Start-means-resume under persistence.** `useJourneyHost` on mount calls `runtime.start()`, which — with a persistence adapter — returns the existing in-flight instance for the same `keyFor(input)` rather than minting a new one. This is what lets a modal close and reopen and pick the wizard back up (the slice-3 requirement, §1.2).
- **Instance fixed for lifetime; remount to restart.** `handle`/`input`/`runtime` read once at setup. Changing `input` later does NOT restart. `<JourneyHost :key="…">` is the restart mechanism.
- **Abandon on unmount, deferred a microtask.** So an open→close→reopen within a tick (or a dev double-mount) doesn't tear down the instance. (React defers for StrictMode; Vue should defer for the analogous reasons — `<KeepAlive>` toggles, HMR, transition-driven remounts.)
- **`instanceId` may be null on first render** — composables no-op on null so they can be called unconditionally above an early return.

**Also ship a `@modular-vue/journeys/testing` entry** mirroring `@modular-react/journeys/testing`, so cat-factory can unit-test its journeys (the initiative requires e2e + unit coverage per slice, and journey step logic wants a headless driver).

### 4B. Modal/tab-mounted journeys outside routes (the first named upstream item)

The React binding already hosts journeys host-agnostically; the deliverable for Vue is to make the **no-route, modal-hosted** path first-class and documented, not merely possible:

1. **`JourneyHost`/`JourneyOutlet` must work with zero router involvement.** No `useRoute`/`useRouter` on the baseline path; the instance lifecycle is driven purely by mount/unmount + the runtime. (cat-factory mounts `<JourneyHost>` inside a `UModal` whose `open` is a `ui`-store boolean.) URL sync is strictly opt-in via `useJourneySync` + a caller-supplied `JourneySyncPort`.
2. **`createJourneyMountAdapter` for Vue** — the `RuntimeMountAdapter` producer, so a journey can be embedded by other Vue surfaces (compositions/zones) without depending on `@modular-vue/journeys` directly, exactly as the React adapter serves `@modular-react/compositions`.
3. **A documented modal recipe** (see §4F): `<UModal>`-style host + `<JourneyHost>` + a `finish`/`abort` exit that closes the modal, and the resume-on-reopen behaviour. Include the "cancel button rewinds vs. closes" guidance (`runtime.goBack(id)` vs. abandoning).
4. **Optional (only if cheap): a vue-router `JourneySyncPort` helper.** A `createVueRouterJourneySyncPort(router, { basePath, stepToPath })` that adapts vue-router to the neutral `JourneySyncPort` (`read`/`push`/`replace`/`go`/`subscribe`). cat-factory won't use it for the modal wizards (no URL), but it's the obvious next consumer question and keeps the Nuxt story complete. Ship only if it's a thin wrapper over the neutral `createJourneySync`.

### 4C. Pinia-backed journey persistence + the deferred `Store<T>` Pinia adapter (the second named upstream item)

Two related deliverables, both Pinia interop:

1. **`createPiniaJourneyPersistence`** — a `JourneyPersistence<TState, TInput>` implementation backed by a Pinia store (or a documented factory that takes a `useStore`-style handle and stores serialized blobs keyed by `keyFor`). Semantics identical to `createWebStoragePersistence` but the backing store is Pinia, so:
   - journey state participates in the app's existing Pinia devtools/timeline,
   - a single reset/`$reset` path can clear in-flight journeys,
   - SSR-safety is a non-issue for `ssr: false` consumers (cat-factory), but the adapter should be pure-client-safe like the web-storage one.

   If a full adapter is more than the engine wants to own, the minimum acceptable deliverable is a **documented recipe** (a ~15-line `JourneyPersistence` over a Pinia store) in the Vue journeys guide — but a shipped `createPiniaJourneyPersistence` is strongly preferred so every Vue consumer doesn't re-derive `keyFor`/serialization/removal subtly differently (the same argument that justified `resolveComponentRegistry` in slice 2).

2. **The `Store<T>` Pinia adapter** deferred from slice 0 (library `docs/vue-support-tracker.md` decision D3). The engine's DI `Store<T>` contract is zustand-shaped (`getState`/`setState`/`subscribe`); a thin adapter presenting Pinia's `$state`/`$subscribe`/`$patch` behind that contract lets cat-factory's 70 Pinia stores participate as registry-owned `stores`/`reactiveServices` without a parallel state layer. Slice 3 is the first slice where a journey's state genuinely wants to be a shared, DI-visible Pinia store, so this is the natural slice to land it. Ship it in `@modular-vue/vue` (or `@modular-vue/core`) as `createPiniaStoreAdapter(useStore)` / `piniaStore(...)`, framework-idiomatic.

### 4D. Version alignment (Gap D)

- **`@modular-frontend/journeys-engine`**: bump its `@modular-frontend/core` dependency from `0.1.0` to `^0.2.0` so pulling the engine into a Vue-family tree (already on `@modular-frontend/core@0.2.0`) doesn't duplicate/downgrade the neutral core. Republish the engine (patch/minor) with the widened dep.
- **`@modular-vue/{vue,runtime,nuxt}`**: widen their `@modular-frontend/core` peer range to include `^0.2.0` (closing the slice-2 residual noted in the slice-2 spec's status). `@modular-vue/journeys` should peer/dep `^0.2.0` from birth.
- Follow the library's own version-coordination policy (`docs/vue-support-tracker.md`) for the coordinated engine→binding release train.

### 4E. Nuxt integration — journeys through `installModularApp`

`@modular-vue/nuxt@0.1.1`'s `installModularApp`/`buildModularPluginContents` wire modules/slots/nav/DI but are journey-unaware. To host journeys in a Nuxt layer (cat-factory's `app/plugins/modular.client.ts`, `enforce: 'post'`), the resolved manifest needs its `journeys` runtime made available to `<JourneyProvider>`/`<JourneyOutlet>`:

- When the registry is built with `journeysPlugin()`, `manifest.extensions.journeys` is the `JourneyRuntime`. `installModularApp` should optionally **provide that runtime** (a `provide`/`app.provide` under the key `<JourneyProvider>` reads) so a layer consumer doesn't hand-thread it. Equivalent to today's `provideSlots`/`provideNavigation` wiring, extended to journeys.
- Keep it opt-in: an app with no `journeysPlugin` registered is unchanged. cat-factory's `ssr: false` singleton-registry case is the simple one (no per-request runtime), matching the slice-0 hardening.
- `@modular-vue/nuxt` graduating past `0.1.x` is a nice-to-have alongside this (slice 0 flagged it), but not required — the layer uses `installModularApp` from a hand-written plugin (Option B), so the runtime `provide` hook is what matters.

### 4F. Docs

- **`docs/journeys-vue.md`** — the Vue journeys guide, mirroring the React journeys docs: `defineJourney`/`defineJourneyHandle`, `<JourneyProvider>` + `<JourneyHost>`/`<JourneyOutlet>`, the composables, lifecycle rules (fixed instance, start-means-resume, abandon-on-unmount), and the exit/terminal model.
- **A modal-mount recipe** (§4B) — host a journey in a modal with no URL; resume on reopen; cancel semantics.
- **A Pinia-persistence recipe** (§4C) — `createPiniaJourneyPersistence` (or the hand-rolled `JourneyPersistence` over a Pinia store) + the `Store<T>` Pinia adapter.
- Cross-link from `framework-mode-nuxt.md`'s consumer-seam section (added in slice 0) and the neutral journeys docs.

## 5. How cat-factory will consume it (so the API is validated against a real shape)

Once released, slice 3 lands on the cat-factory side, pilot-first:

1. **`EnvironmentSetupWizard` becomes a journey.** The `pick → review → preflight → save` steps become journey modules (or one module with four entries) authored with `defineJourney`; the `environmentWizard.ts` store's cross-step state becomes the journey's `TState`; `goToStep`/`back`/`next` become transitions; `resetFlowState()` disappears (a fresh journey per `keyFor(frameId)` replaces manual reset — re-targeting a different frame is a new instance, not a hand-cleared old one). The modal renders `<JourneyHost :handle="envSetupHandle" :input="{ frameId }">` inside the existing `UModal`, with the stepper crumbs driven by `stepIndex`/the instance's `step`. All existing `data-testid`s are preserved (the e2e-first rule); a live-push e2e spec covers the flow before the refactor.
2. **Persistence is `createPiniaJourneyPersistence`**, keyed by `frameId`, so closing and reopening the modal resumes the same in-flight setup — a UX improvement the hand-rolled store can't currently offer (it resets on every open).
3. **No URL involvement.** The journey is purely modal-hosted (§4B baseline). `useJourneySync` is not used for these wizards.
4. **Then `BootstrapModal` and the onboarding flows** convert to journeys against the same primitives, once the pilot proves the shape.

The reflection (what fit / what bent) and any residual bends go in the slice-3 PR description and the tracker's slice-3 row, per the co-evolution protocol.

## 6. Acceptance criteria

- `@modular-vue/journeys` is published and `import { JourneyHost, JourneyOutlet, JourneyProvider, useJourneyHost, useJourneyState, defineJourney, createJourneyRuntime, journeysPlugin } from '@modular-vue/journeys'` type-checks and works at runtime in a Vue/Nuxt `ssr: false` app.
- `<JourneyHost>` in a modal with **no router**: starts on mount, renders steps, advances/rewinds, finishes via a terminal exit, and abandons on unmount. Unit- and e2e-demonstrated.
- **Start-means-resume**: with a persistence adapter, unmounting and remounting `<JourneyHost>` for the same `keyFor(input)` resumes the in-flight instance rather than starting fresh. Test-covered.
- **Instance is fixed for lifetime**; changing `input` does not restart; `:key` remount does. Test-covered.
- `createPiniaJourneyPersistence` (or the documented Pinia `JourneyPersistence` recipe) round-trips `keyFor`/`load`/`save`/`remove` against a Pinia store. Test-covered.
- The `Store<T>` Pinia adapter presents a Pinia store behind the engine's `getState`/`setState`/`subscribe` contract. Test-covered. (Slice-0 D3 closed.)
- `useJourneySync` + a `JourneySyncPort` reconciles a journey with a URL when opted in (router-neutral). Test-covered. (vue-router port helper optional.)
- `@modular-vue/journeys/testing` provides a headless journey driver mirroring `@modular-react/journeys/testing`.
- `@modular-frontend/journeys-engine` deps `@modular-frontend/core@^0.2.0`; `@modular-vue/{vue,runtime,nuxt}` peer-ranges include `^0.2.0`; `pnpm peers check` is clean in a Vue-family tree that also installs the engine.
- `installModularApp` optionally provides `manifest.extensions.journeys` so `<JourneyProvider>` resolves from context in a Nuxt layer; an app without `journeysPlugin` is unchanged.
- Docs: `journeys-vue.md` + modal-mount recipe + Pinia-persistence recipe, cross-linked from the Nuxt consumer-seam and neutral journeys guides.
- No breaking changes to existing packages; new package + additive widens released under the appropriate labels per the library's versioning policy.

## 7. Out of scope

- **Route modules / `createRoutes` / route-driven zones.** cat-factory is single-route; journeys here are modal/tab-hosted (§4B). The route-centric surface stays unused per the initiative.
- **Compositions engine** (`@modular-frontend/compositions-engine`) — not needed for the wizard target area; the journey mount adapter (§4B) is provided for it but cat-factory won't wire compositions in slice 3.
- **The cat-factory-side wizard refactors themselves** (§5) — cat-factory-local, land after the release.
- **SSR journey hosting** — cat-factory is `ssr: false`; the binding need only be SSR-safe in the trivial sense (client-only mount), matching the slice-0 Nuxt hardening. Full SSR journey hydration is not requested here.

---

_When this is released, add `@modular-vue/journeys` (+ any bumped pins) to `frontend/app/package.json` and `minimumReleaseAgeExclude` (namespace we own), then land the cat-factory slice-3 side described in §5 and update the slice-3 row in the tracker._
