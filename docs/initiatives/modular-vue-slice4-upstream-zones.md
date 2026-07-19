# Upstream request (modular-react / modular-vue): a Vue **subject-keyed zones** binding (`@modular-vue/zones`) — state-driven detail panels, contributed by modules, rendered outside routes

**For:** the modular-react maintainers (`@modular-frontend/*` engine + `@modular-vue/*` bindings + `docs/`).
**From:** the cat-factory frontend team, driving [modular-vue adoption slice 4 ("Inspector panels")](./modular-vue-adoption.md).
**Type:** a **subject-keyed panels** primitive (the Vue analogue of the React zones/detail surface), made **subject-keyed and route-free**, plus the carry-over peer-range widen tracked since slice 2. Additive; no breaking changes to existing packages.
**Status:** ✅ **RELEASED + RE-ADOPTED.** Shipped essentially as specced, but as a **subject-keyed _panels_ primitive** rather than a new `@modular-vue/zones` package (the route-driven "zones" surface stays as-is; this is a distinct, sibling primitive): `@modular-frontend/core@0.4.0` adds `PanelEntry<TSubject>` / `PanelGroupHandle<TSubject>` / `definePanelGroup<TSubject>(slotKey)` / `resolvePanels(entries, subject, opts?)`, and `@modular-vue/vue@1.3.0` (re-exported from `@modular-vue/core@1.3.0`) adds `PanelsOutlet` / `usePanels` / `usePanelSubject` / `panelSubjectKey`. cat-factory bumped the pins and landed the consuming slice (§5) with **no shim**. Two deltas from the spec below and two residuals, all recorded in the [tracker](./modular-vue-adoption.md)'s slice-4 outcomes:

- **Naming:** `definePanelGroup` / `PanelEntry` / `PanelsOutlet` / `usePanels` / `usePanelSubject` (not the `defineZone` / `ZoneContribution` / `ZoneOutlet` / `useZone` / `useZoneSubject` names proposed below). Same semantics.
- **No `section` field (§4C).** A panel group is backed by ONE slot key (`definePanelGroup(slotKey)`), so multiple regions = multiple groups rather than one group with sections. cat-factory needed only one group (`inspectorPanels`) — the shell keeps its other regions — so this cost nothing.
- **Residual 1 — peer range not widened (Gap D / §4D):** the `@modular-vue/*` bindings re-export the panels from `@modular-frontend/core@0.4.0` but still peer-range it at `^0.1.0 || ^0.2.0 || ^0.3.0`, so installing the required `0.4.0` emits a benign unmet-peer warning (non-fatal; the repo has no `strict-peer-dependencies`). Widen the bindings' peer to include `^0.4.0` upstream (same shape as slice 0's vue-router and slice 2's core widen).
- **Residual 2 — engine still deps the old core:** `@modular-frontend/journeys-engine@1.8.0` (pulled transitively by `@modular-vue/journeys`) deps `@modular-frontend/core@0.3.0`, which would drag a SECOND copy of the neutral core in beside `0.4.0` (exactly the §4D hazard). cat-factory pins one core via a `@modular-frontend/core: 0.4.0` pnpm override (0.4.0 is an additive superset of 0.3.0); bump the engine's core dep to `^0.4.0` upstream to drop the override.

The spec below is retained as the design record.

---

**(Original request, as filed before the release.)** modular-vue ships module hosting, slots, navigation, DI, remote manifests, journeys (slice 3), and the pick-one component registry (slice 2) — but its **zones surface is route-driven** (a zone's contributions are selected by the active route), and cat-factory is a single-route board app whose detail panels vary by **application state**, not by URL. There is no primitive that renders _all_ the panels matching a runtime **subject** (the selected board block), gated by per-panel predicates over that subject, ordered, and contributable by first-party AND consumer modules. Hand-rolling it in cat-factory is precisely the "local shim that outlives its slice" the initiative forbids. This document is the co-evolution artifact for slice 4: the upstream half, written before the cat-factory half so the two land as a matched set.

> Self-contained by design — read it without cat-factory context. The initiative tracker's slice-4 row ("Expected upstream workstream: A zones-without-routes story: zone contributions keyed by app state instead of the active route") points here. It mirrors the slice-2 spec ([`modular-vue-slice2-upstream-pairing.md`](./modular-vue-slice2-upstream-pairing.md)) and slice-3 spec ([`modular-vue-slice3-upstream-journeys.md`](./modular-vue-slice3-upstream-journeys.md)), both of which shipped essentially as written.

---

## 1. Context — the consumer pressure

cat-factory is a Nuxt SPA (`ssr: false`) adopting modular-vue as a phased strangler migration. Slices 0–3 landed: the registry factory in the layer (slice 0), a nav/command manifest on `useReactiveSlots` (slice 1), a result-view registry + remote-capability pairing (slice 2), and journey-hosted wizards (slice 3). **Slice 4 converts the app's biggest hand-rolled detail surface — the block inspector — into a registry of module-contributed panels.**

The target is one 631-line monolith, `InspectorPanel.vue`:

- It inspects **whatever board block is currently selected** (`ui.selectedBlockId` → `board.getBlock`), a single reactive **subject** that changes as the user clicks around the board.
- It renders a **shared shell** (status bar, header with type icon + title + status badge + level label + close, an editable title/description block, an actions row) that is constant across every subject.
- Between the shell's halves it swaps in **level-specific and type-specific content** via a fan of independent `v-if` blocks plus one `v-else-if` chain, keyed off the subject's discriminators:
  - `block.level` ∈ `frame | module | task | epic | initiative` (the primary discriminator), and
  - `block.type` ∈ `frontend | service | …` (a secondary discriminator, used only inside the frame branch), and
  - **live run state** (a failed run shows `AgentFailureCard`; a running bootstrap shows `AgentStopButton`) — visibility that is neither level nor type but a predicate over the block's current run.

Concretely, ~19 sub-panels are gated like this today (all in `frontend/app/app/components/panels/inspector/` unless noted):

| Panel                                                                                                                                        | Renders when (predicate over the selected block)        |
| -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| `ContainerSummary`                                                                                                                           | `level ∈ {frame, module}`                               |
| `FrontendConfig`                                                                                                                             | `level === frame && type === frontend`                  |
| `ServiceConnections`                                                                                                                         | `level === frame && type === service`                   |
| `ServiceTestConfig` / `ServiceTestSecrets`                                                                                                   | `level === frame`                                       |
| `ServiceFragments` / `ServiceReleaseHealthConfig`                                                                                            | `level === frame`                                       |
| `TaskContextDocs`, `TaskContextIssues`                                                                                                       | `level === task`                                        |
| `RecurringScheduleSettings`, `TaskExecution`, `TaskEstimateBadge`, `TaskDependencies`, `TaskRunSettings`, `TaskAgentConfig`, `TaskStructure` | `level === task` (a fixed render order)                 |
| `EpicChildren`                                                                                                                               | `level === epic`                                        |
| `InitiativeInspector`                                                                                                                        | `level === initiative`                                  |
| `AgentFailureCard` (board/)                                                                                                                  | the block's current run `status === failed` (any level) |
| `AgentStopButton` (board/)                                                                                                                   | a running bootstrap on a container (any level)          |

Two properties matter and drive the named sub-requests below:

1. **This is a "zone" keyed by state, not by route.** cat-factory is single-route (the "No route modules" convention is a hard initiative rule); the inspector is a named region whose contributions are selected by the **selected block's** level/type/run-state — never by the URL. modular-vue's zones select contributions by the **active route**, so they don't apply.
2. **A subject must be threaded to both the gate and the panel.** Each contribution needs the selected block (a) to decide whether it renders (`when(block)`) and (b) as the `:block` prop it renders with. Plain slots (see §2) model neither: a slot is a flat concatenated array with a _global_ `slotFilter`, and it has no notion of a per-render subject injected into the rendered component.

The extensibility payoff (slice 4's whole point, and the reason a registry beats "just refactor the `v-if`s into a local map"): a **consumer deployment** that ships a custom block type or level — the backend already supports custom agent kinds and custom block types — must be able to contribute its **own** inspector panels for it **without forking `InspectorPanel.vue`**, exactly as a consumer contributes nav items (slice 1) and result views (slice 2) today. A hardcoded local `v-if` map, however tidy, can't be extended by a consumer; a module-contributed zone can.

## 2. What exists today, and exactly where it stops short

Current published versions (all installable):

| Package                               | Version         | Role                                                                                                                       |
| ------------------------------------- | --------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `@modular-frontend/core`              | `0.2.0`         | Neutral engine: modules, slots, navigation, DI, remote manifests, `resolveComponentRegistry`/`pairById` (slice-2 pairing). |
| `@modular-vue/core` `/vue` `/runtime` | `1.2.0`/`1.3.0` | Vue bindings for modules, slots (`useReactiveSlots`), navigation, DI, the pairing re-exports.                              |
| `@modular-vue/journeys`               | `1.1.0`+        | Vue journeys binding (slice 3): host/outlet/provider/sync + Pinia persistence.                                             |
| `@modular-vue/nuxt`                   | `0.3.0`         | Nuxt install — `installModularApp` (modules + slots + nav + DI + journeys extension).                                      |
| **`@modular-vue/zones`**              | **— (404)**     | **Does not exist.** (`@modular-vue/vue` exposes no state-keyed zone surface.)                                              |

The three primitives that _look_ adjacent each stop short in a specific, load-bearing way:

### Gap A — zones are **route-driven**; there is no **state/subject-keyed** zone

The engine's zones select a zone's contributions by the **active route** (route-driven zones are, per the initiative's own fit analysis, "unused surface" for a single-route app). cat-factory's inspector is a zone whose contributions are selected by the **selected block** — a piece of reactive application state, not a route. What's missing is a zone whose contribution set is a function of a caller-supplied **subject** (`when(subject)` per contribution), re-evaluated reactively as the subject changes, with **zero router involvement** on the baseline path. This is the tracker's named item: _"zone contributions keyed by app state instead of the active route."_

### Gap B — **slots** gate globally and thread no subject

Slice 1 built the nav/command manifest on plain slots + a reactive global `slotFilter` (`navSlotFilter` reads a global `gates` service). That is the right shape for nav — one flat catalog gated by a global RBAC/availability service. It is the **wrong** shape for a detail panel:

- A slot's `slotFilter` receives `(slots, deps)` — **not a subject.** To gate the inspector on the selected block you'd have the filter reach into a store for `ui.selectedBlockId`, i.e. smuggle the subject in through a global. That couples every inspector predicate to a specific global and makes the zone un-reusable for a _second_ subject-keyed surface (slice 5's agent-run windows, keyed by the selected step).
- A slot entry is inert data (nav uses `{ id, component?, run, gate }`). It has no contract for **injecting the subject into the rendered component** as a prop, and no host that renders _each_ matching entry with that subject. You end up re-writing, per detail surface, the "read the subject, filter, sort, render each with `:subject`, key by subject id" host — which is exactly the per-feature reinvention this initiative exists to kill.

Plain slots _can_ be bent into this (nav proves state-gating on slots is possible), but doing so for a subject-keyed multi-panel surface is a **local re-implementation of a missing zone concept** — a shim, not idiomatic use. That is the distinction slice 1 didn't hit (its gate genuinely is global) and slice 4 does.

### Gap C — the slice-2 **component registry is pick-one**, the inspector needs **render-all**

Slice 2 shipped `resolveComponentRegistry` / `pairById` (`@modular-frontend/core@0.2.0`, re-exported from `@modular-vue/core`): a registry that **selects one** component by id (a step's `resultView` id → the one window). The inspector is the opposite reduction: for one subject it **renders every** matching panel, in order (7 task panels stack; 5 frame panels stack). Pairing-by-id is a lookup; a zone is a **filtered, ordered concatenation** rendered as a subject-parameterised list. Different primitive, deliberately.

### Gap D — carry-over peer-range drift

The slice-2 residual (noted in that spec's status and still open): `@modular-vue/{vue,runtime,nuxt}` still peer-range `@modular-frontend/core@^0.1.0` while the family is on `0.2.0`; only `@modular-vue/core` widened. A new `@modular-vue/zones` should peer/dep `^0.2.0` from birth, and the existing three should be widened in the same release train (a benign peer warning otherwise, exactly like slice 0's vue-router widen, [modular-react#87](https://github.com/kibertoad/modular-react/pull/87)).

## 3. Design principle — a subject-keyed, route-free port of the zones surface

The React zones surface is the reference; the contract bottoms out in the neutral engine. The Vue binding should be a **faithful, idiomatic Vue port**, differing from the route-driven surface only in the two dimensions cat-factory needs: the contribution set is keyed by a **caller-supplied subject** (not the route), and hosting is **route-free** (no `useRoute`/`useRouter` on the baseline path). Same names where they carry over (`defineZone`, `ZoneOutlet`), Vue idiom where it differs (composables return `Ref`/`ComputedRef`; children are slots; the subject arrives as a prop/`provide`). If the engine already models a subject/context on zones, this request is "expose it for Vue, route-free"; if it doesn't, the shape below is the proposal. Maintainers should align names with the existing zones vocabulary — I don't assume the current zone API verbatim.

## 4. Proposed upstream changes

### 4A. New package `@modular-vue/zones` — the Vue subject-keyed zones binding

Publish `@modular-vue/zones` (aligned to the family's current major), depending on the neutral engine (bumped to `@modular-frontend/core@^0.2.0` — §4D) and peer-depending `@modular-vue/core`/`@modular-vue/vue`/`vue`. It must:

**Re-export the neutral zone surface** (so a Vue consumer never reaches past the binding — the principle established in slices 2 and 3): `defineZone`, the zone/contribution types, any zone-manifest resolver, and the registry plumbing.

**Provide the Vue host surface** — a subject-keyed, route-free zone renderer + composable:

```ts
// @modular-vue/zones

/** A single contribution to a subject-keyed zone. `when(subject)` decides
 *  visibility for a given subject; `order` places it; `section` optionally buckets
 *  it (e.g. a detail panel's "body" vs "actions"); `component` receives the subject. */
export interface ZoneContribution<TSubject, TProps = { subject: TSubject }> {
  id: string
  component: Component
  /** Reactive predicate over the current subject; absent = always render. */
  when?: (subject: TSubject) => boolean
  /** Ascending render order within the (optional) section. */
  order?: number
  /** Optional bucket so one zone can drive several regions of a host. */
  section?: string
  /** Extra static props merged with the injected `{ subject }`. */
  props?: Record<string, unknown>
}

/** Declare a typed zone id + subject type. The registry aggregates contributions
 *  to it across all modules (first-party + consumer), exactly like a slot. */
export function defineZone<TSubject>(id: string): ZoneHandle<TSubject>

/** Resolve a zone's contributions for a subject: filter by `when(subject)`, sort by
 *  `order`, bucket by `section`. Reactive — re-evaluates when the subject or the
 *  registered set changes. `null`/absent subject ⇒ empty. */
export function useZone<TSubject>(
  zone: ZoneHandle<TSubject>,
  subject: MaybeRefOrGetter<TSubject | null>,
  options?: { section?: string },
): ComputedRef<readonly ResolvedZoneEntry<TSubject>[]>

/** Render a zone for a subject: mounts each resolved contribution's component with
 *  the subject injected (as the `subject` prop AND via `provide`, so nested content
 *  can `useZoneSubject()`), keyed by `contribution.id + subjectKey` so switching
 *  subjects remounts cleanly. Host-agnostic (panel/modal/sidebar/div), no router.
 *  Slots: `#empty` (nothing matched), `#wrap` (per-entry chrome, e.g. a collapsible
 *  section shell). */
export const ZoneOutlet: DefineComponent<{
  zone: ZoneHandle<any>
  subject: unknown | null
  section?: string
  /** How to key each rendered entry per subject (default: identity of `subject`). */
  subjectKey?: (subject: unknown) => string | number
}>

/** Read the subject provided by the enclosing ZoneOutlet (for deeply nested panels). */
export function useZoneSubject<TSubject>(): Ref<TSubject | null>
```

Semantics that must hold (the load-bearing ones cat-factory relies on):

- **Render-all, not pick-one.** `ZoneOutlet` mounts _every_ contribution whose `when(subject)` passes, in `order`, within the requested `section`. (Contrast slice-2 pairing, which selects one by id.)
- **Subject-reactive.** Changing the subject re-runs every `when` and re-renders; a contribution appearing/disappearing as the subject's state changes (e.g. a run flips to `failed`) is reactive with no manual recompute — the `useReactiveSlots` guarantee, extended to a subject argument.
- **Subject injected two ways.** As the `subject` prop on each component AND via `provide`/`inject` (`useZoneSubject`) so a deeply-nested panel needn't prop-drill. Keyed per subject so no state bleeds across selections.
- **Route-free baseline.** No `useRoute`/`useRouter` anywhere on the default path (§4B). A future route-synced zone is strictly opt-in.
- **Contributed by modules.** A zone's contributions are declared on module descriptors (`defineModule({ zones: { inspector: [...] } })`) and aggregated by the registry across first-party AND consumer modules — the same seam slots/nav use, so a consumer contributes panels through `registerAppModule` with no host edit.

Also ship a **`@modular-vue/zones/testing`** entry (a headless resolver: given a subject + a set of contributions, assert the filtered/ordered result) so a consumer can unit-test its zone predicates and ordering without a DOM — the initiative requires unit + e2e coverage per slice.

### 4B. Route-free hosting (the named upstream item)

Make the **no-route, state-hosted** path first-class and documented, not merely possible:

1. `ZoneOutlet`/`useZone` must work with **zero router involvement** — the contribution set is a pure function of `(registered contributions, subject)`; nothing reads the URL. (cat-factory mounts `<ZoneOutlet>` inside a fixed panel whose subject is a `ui`-store computed.)
2. An **opt-in** route-sync helper is fine to offer for the routed case, but must not be on the baseline import path (mirrors journeys' `useJourneySync` being opt-in in slice 3).
3. A documented **detail-panel recipe** (§4F): a host component that renders shared chrome + `<ZoneOutlet zone="inspector" :subject="block" section="body">`, with the "consumer contributes a panel for a custom subject type" story shown end to end.

### 4C. Subject typing + the section model

- `defineZone<TSubject>(id)` carries the subject type so `when`/`component` are checked against it; a contribution's `component` is expected to accept `{ subject: TSubject }` (plus its own props via `props`).
- The **`section`** field lets one logical zone drive several regions of a host without inventing a zone per region. cat-factory's inspector has a natural `body` region (the ~19 level/type panels) and could use `banners` (the failure/stop cross-cutting panels) and `actions` — one `inspector` zone, three sections — rather than three zone ids. Sections are optional; a zone with no sections is a single ordered list.
- Ordering is stable ascending `order`; ties break by registration order (documented), so a consumer can interleave its panels among the first-party ones deterministically.

### 4D. Version alignment (Gap D)

- `@modular-vue/zones` peer/deps `@modular-frontend/core@^0.2.0` from birth.
- Widen `@modular-vue/{vue,runtime,nuxt}`'s `@modular-frontend/core` peer range to include `^0.2.0` in the same release train (closes the slice-2 residual). `pnpm peers check` must be clean in a Vue-family tree that also installs the engine.
- Follow the library's version-coordination policy (`docs/vue-support-tracker.md`) for the coordinated engine→binding release.

### 4E. Nuxt integration — zones through `installModularApp`

`@modular-vue/nuxt`'s `installModularApp` already wires modules/slots/nav/DI and (since slice 3) the journeys extension. Extend it so a registry built with a zones plugin makes the resolved **zone manifest** available to `<ZoneOutlet>` from context (a `provide`, like `provideSlots`/`provideNavigation`/the slice-3 journeys `provide`), so a Nuxt-layer consumer doesn't hand-thread it. Keep it opt-in: an app with no zones registered is unchanged. cat-factory's `ssr: false` singleton-registry case is the simple one (no per-request state), matching the slice-0/-3 hardening. The registry's plugin-extension type should flow through `installModularApp` (as the slice-3 nuxt@0.3.0 change did for journeys) so `manifest.zones` is typed rather than cast.

### 4F. Docs

- **`docs/zones-vue.md`** — the Vue zones guide: `defineZone`, `<ZoneOutlet>`/`useZone`, the subject/`when`/`order`/`section` model, reactivity + injection rules, and the render-all-vs-pick-one distinction from the slice-2 pairing guide.
- **A state-hosted detail-panel recipe** (§4B) — shared chrome + `<ZoneOutlet :subject>`; a consumer contributing a panel for a custom subject; preserving host-owned regions.
- Cross-link from `framework-mode-nuxt.md`'s consumer-seam section and the neutral zones docs; contrast with `remote-capability-manifests.md` (pick-one pairing) so readers pick the right primitive.

## 5. How cat-factory will consume it (so the API is validated against a real shape)

Once released, slice 4 lands on the cat-factory side, monolith-first:

1. **`InspectorPanel.vue` keeps only its shared shell** (status bar, header, editable identity, the actions row) and hosts `<ZoneOutlet zone="inspector" :subject="block" section="body">` where the level/type `v-if` fan is today. `block` is the existing `ui.selectedBlockId → board.getBlock` computed — the subject.
2. **Each sub-panel becomes a `ZoneContribution`** with a `when(block)` predicate lifted verbatim from its current `v-if`, an `order` preserving today's render order, and `section` bucketing (`body` for the ~19 level/type panels, `banners` for `AgentFailureCard`/`AgentStopButton`, `actions` for run/focus/archive/delete). The `block.type === frontend|service` secondary discriminator is exactly why arbitrary `when(block)` predicates (not a fixed `level → panels` map) are required — visibility is `level && type && run-state`, which a keyed map can't express but a predicate can.
3. **First-party panels register through a first-party `inspector` zone module** (like `result-views.ts`, imported from the client plugin so its SFC imports stay out of the unit-tested `registry.ts` graph). The pure predicate/order table is unit-tested via `@modular-vue/zones/testing`; a live-push e2e spec covers the inspector before the refactor (e2e-first).
4. **A consumer deployment contributes its own inspector panels** for its custom block types/levels by contributing to the same `inspector` zone via `registerAppModule` — zero `InspectorPanel.vue` edits. This is the slice-4 extensibility promise, dogfooding the exact seam consumers use (the frontend analogue of `registerGate`/`registerAgentKind`).
5. **Every existing `data-testid` is preserved** (the e2e rule), so the board's inspector e2e coverage is unchanged by the refactor.
6. **Slice 5 reuses the same primitive.** The agent-run result windows (`RequirementsReviewWindow`, `TestReportWindow`, `AgentStepDetail`, …) share dialog chrome and are keyed by the selected step — a second subject-keyed zone (`subject = the step`). Building the primitive upstream now means slice 5 composes it instead of hand-rolling a second detail-panel host — the reuse that justifies a first-class zone over a local `v-if` map.

The reflection (what fit / what bent) and any residual bends go in the slice-4 PR description and the tracker's slice-4 row, per the co-evolution protocol.

## 6. Acceptance criteria

- `@modular-vue/zones` is published and `import { defineZone, ZoneOutlet, useZone, useZoneSubject } from '@modular-vue/zones'` type-checks and works at runtime in a Vue/Nuxt `ssr: false` app.
- `<ZoneOutlet :zone :subject>` with **no router**: renders _every_ contribution whose `when(subject)` passes, in `order`, bucketed by `section`, each with the subject injected as a prop and via `provide`. Unit- and e2e-demonstrated.
- **Subject-reactive**: changing the subject re-evaluates all `when` predicates and re-renders with no manual recompute; a contribution whose predicate reads mutable subject state (e.g. a run status) appears/disappears reactively. Test-covered.
- **Render-all, not pick-one**: two contributions matching one subject both render, ordered; verified distinct from `pairById`'s single selection.
- **Module-contributed + consumer-extensible**: a contribution registered by a _consumer_ module through the registry appears in the zone with no host edit. Test-covered.
- `@modular-vue/zones/testing` resolves `(contributions, subject) → ordered visible entries` headlessly for unit tests.
- `installModularApp` optionally provides the resolved zone manifest so `<ZoneOutlet>` resolves from context in a Nuxt layer; an app with no zones registered is unchanged; the extension type flows through (typed `manifest.zones`, no cast).
- `@modular-frontend/core@^0.2.0` peer/dep alignment; `@modular-vue/{vue,runtime,nuxt}` peer-ranges include `^0.2.0`; `pnpm peers check` is clean.
- Docs: `zones-vue.md` + the state-hosted detail-panel recipe + the pick-one-vs-render-all contrast, cross-linked from the Nuxt consumer-seam and neutral zones guides.
- No breaking changes to existing packages; new package + additive widens released under the appropriate labels per the library's versioning policy.

## 7. Out of scope

- **Route-driven zones / `createRoutes` / route-synced zones.** cat-factory is single-route; the inspector is state-hosted (§4B). The route-centric surface stays unused per the initiative; the opt-in route-sync helper (§4B.2) is a nice-to-have, not required.
- **Compositions engine** (`@modular-frontend/compositions-engine`) — not needed for the inspector; the zone renderer stands alone.
- **Backend-delivered (remote-manifest) zones.** cat-factory's inspector panels are all code-shipped components; a wire-safe "backend selects which panels" manifest (the zone analogue of slice-2's remote agent-kind manifest) is a plausible future need but is **not** requested here — keep the first cut code-only.
- **The cat-factory-side inspector refactor itself** (§5) — cat-factory-local, lands after the release.
- **SSR zone hosting** — cat-factory is `ssr: false`; the binding need only be SSR-safe in the trivial client-only-mount sense, matching the slice-0/-3 Nuxt hardening.

---

_When this is released, add `@modular-vue/zones` (+ any bumped pins) to `frontend/app/package.json` and `minimumReleaseAgeExclude` (namespace we own), then land the cat-factory slice-4 side described in §5 and update the slice-4 row in the tracker._
