# ADR 0049: modular-vue adoption (frontend modularity and the co-evolution loop)

- **Status:** Accepted (implemented)
- **Date:** 2026-08-07
- **Context layer:** frontend (`@cat-factory/app`) plus the `@modular-vue/*` and
  `@modular-frontend/*` packages it consumes

Supersedes the `modular-vue-adoption` initiative tracker and its `modular-vue-slice5-progress`
child, whose committed scope (slices 0 to 5) is complete, along with the four upstream request
specs written against the modular-react repo, all of which shipped and were re-adopted. The
consumer-facing extension surface built ON TOP of these seams is a separate, still-open initiative:
[`frontend-extension-mechanism.md`](../../../docs/initiatives/frontend-extension-mechanism.md).
Authoring rules for the seams live in
[`frontend/app/README.md`](../../../frontend/app/README.md).

## Context

Two problems in `frontend/app`, one library addressing both.

**The extensibility ceiling.** Everything pluggable in the SPA was data-driven from the backend
snapshot. A consumer deployment (`deploy/frontend` is a thin `extends` shell) could rebrand,
retheme and override locale strings, but it could not contribute COMPONENTS: not a step result view
(`STEP_RESULT_VIEWS` was a hardcoded `Record`), a navbar or command-palette entry (hand-written item
lists), an inspector panel (`InspectorPanel.vue` switched on `block.level` with `v-if` sections), or
a modal (`pages/index.vue` mounted around 50 by hand). A company wanting a proprietary frontend
extension for its custom agents had exactly one option: fork the layer. The backend had solved the
equivalent problem with public registries; the frontend had no counterpart.

**Hand-rolled structure in the areas the platform keeps growing.** Navigation was three hardcoded
lists plus per-item RBAC computeds; every guided flow reinvented step tracking and back/next gating;
the block inspector was a `v-if` monolith; the roughly 18 agent-run result windows each hand-rolled
the same modal chrome and re-implemented modal BEHAVIOUR inconsistently (only 2 of 18 trapped focus,
each registered its own global Escape listener, every one hard-coded `z-50` with no stacking).

## Decision

Adopt modular-vue in `@cat-factory/app` as a phased strangler migration of the non-route primitives
(registry, slots, journeys, remote manifests, DI), under three conditions about HOW rather than
whether:

1. **The co-evolution loop is honored every slice.** A gap found mid-slice is fixed upstream and the
   released improvement re-adopted before the slice closes. A slice with a lingering local shim is
   still open.
2. **Strangler-only.** Each slice converts one seam and leaves the rest untouched.
3. **Route-module restructure and compositions are out of scope**, revisited only if the app grows
   real routes.

The per-slice protocol: adopt the primitive, reflect on what fit and what bent, file every bend
upstream as a real PR in the modular-react repo (code, tests and docs, carrying a release label),
land and release it, then re-adopt immediately and delete any interim shim. While an upstream PR is
unreleased, cat-factory develops against a temporary `file:` link.

### What each slice converted

- **Slice 0, the registry in the layer.** `app/modular/registry.ts` builds a `@modular-vue/runtime`
  registry, registers the first-party modules, then everything a consumer contributed through the
  auto-imported `registerAppModule(...)`. Module descriptors carry Vue components and so cannot
  travel through serializable Nuxt config, which is why the seam is an in-process array.
- **Slice 1, navigation.** `app/modular/nav-contributions.ts` declares every nav and command
  destination once as data; `SideBar`, `CommandBar` and `BoardToolbar` render from it through
  `useNavContributions()`, replacing three hand-maintained lists. RBAC gating is a `slotFilter` over
  a reactive `gates` service read through `useReactiveSlots`, so an item shows or hides the instant a
  permission or connection flips. A catalog item's `action` is a `NavActionId` union resolved against
  a `Record<NavActionId, () => void>`, so drift between catalog and handler map is a compile error
  rather than a silently dead button.
- **Slice 2, result views.** Every built-in window is a `ComponentEntry` in the first-party
  `resultViews` slot, indexed with the upstream `resolveComponentRegistry`. Backend-registered custom
  kinds arrive as a per-workspace `RemoteModuleManifest`; code-shipped consumer kinds enter through a
  static `agentKinds` slot. `agentPresentationSchema.resultView` was opened to accept a built-in id
  OR a consumer-namespaced `<ns>:<name>` (a bare non-built-in id still fails, keeping the typo
  guardrail), which is what lets a BACKEND-registered kind select a CONSUMER view end to end.
- **Slice 3, wizards.** The environment-setup wizard runs on journeys with Pinia-backed resume keyed
  by the target frame. A whole-codebase survey established it is the only genuine multi-step wizard;
  the other named targets are single-screen and were deliberately not force-converted.
- **Slice 4, inspector panels.** `InspectorPanel.vue`'s level/type `v-if` fan became an
  `inspectorPanels` group via `definePanelGroup<Block>` with the pure id/order/`when` specs pinned by
  `resolvePanels`.
- **Slice 5, agent-run window chrome.** All 18 result windows render through one
  `ResultWindowShell`, which owns the chrome (Teleport, backdrop, bordered card, header, close, the
  shared effort-report footer) and delegates behaviour to the upstream `useModalBehavior` for focus
  trap, focus return, body-scroll lock and a shared overlay stack where the top overlay closes first
  on Escape. Selection is unchanged, so windows converted independently with no host or registry
  changes.

### What shipped upstream and was re-adopted

Each upstream half landed as specced and is consumed from a published release, with no shim left
behind: the reactive slot read (`useReactiveSlots`), the remote-manifest × locally-registered
component pairing (`resolveComponentRegistry` / `pairById` / `ComponentEntry` plus the pairing
guide), the Vue journeys binding with Pinia persistence, the subject-keyed panels primitive
(`definePanelGroup` / `resolvePanels` / `PanelEntry`, `PanelsOutlet` / `usePanels` /
`usePanelSubject`), and the `useModalBehavior` overlay-behaviour hook.

## Rationale

- **A local shim that outlives its slice is the failure mode.** Hand-rolling an outlet, host,
  provider or sync layer inside cat-factory would have bought each slice a week and left the app
  owning a private fork of a library primitive. Filing upstream and blocking the slice on the release
  is what keeps the seam one thing rather than two.
- **The panels primitive is subject-keyed rather than route-driven** because cat-factory is a
  single-route board app whose detail panels vary by application state. It shipped as a distinct
  sibling to the route-driven zones surface rather than replacing it.
- **A slotted shell beat the headless outlet for slice 5.** The upstream `OverlayOutlet` renders a
  window as opaque `children`, which would force each window's dynamic title and badges through entry
  metadata. cat-factory's per-window headers fit a slotted shell over `useModalBehavior`, the
  sanctioned upstream API for exactly this bespoke-root case, so the shell is a component the window
  renders and header variance stays in the window via `#header-extras`.
- **First-party features register through the seam consumers use**, dogfooding the extension story
  the way `@cat-factory/gates` dogfoods `registerGate` on the backend.

## Consequences

- **Plugin ordering is load-bearing.** The layer's install plugin is `enforce: 'post'`, because Nuxt
  loads layer plugins before the consuming app's within one enforce bucket, so a consumer registering
  from a normal plugin would otherwise run after the layer resolves and be missed. A consumer
  contributes from a default or `pre` plugin.
- **One neutral core, pinned.** The `@modular-vue/*` bindings and `@modular-frontend/journeys-engine`
  depend on `@modular-frontend/core` across overlapping-but-not-identical ranges, so without the
  workspace override pnpm can resolve more than one copy into the tree, giving panels, overlays and
  journey step metadata distinct type identities. The override stays until the bindings' peer ranges
  and the engine's core dep catch up upstream.
- **`vue` is pinned up rather than the upstream peer relaxed**, and `@modular-vue/*` /
  `@modular-frontend/*` are in `minimumReleaseAgeExclude` as namespaces we own.
- **Two slice-5 refinements are deliberately deferred**: promoting the shared header controls to a
  step-keyed `resultWindowHeader` panel group so a consumer can contribute a header control (the
  extensibility half, which belongs with the frontend-extension-mechanism work), and bringing the two
  full-bleed panels (`AgentStepDetail`, `ObservabilityPanel`) onto `useModalBehavior` directly. They
  are driven by separate `ui` state, are `<Transition>`-wrapped and full-bleed, so they do not fit
  the centered-card shell and were never among the 18.
- **Body-level reuse across the windows is a purely cat-factory-side follow-up** needing no upstream
  primitive: the shell unified chrome and behaviour, while several body sub-patterns are still
  copy-pasted.
- **The conventions survive the tracker.** No local shims outliving their slice; feedback lives
  upstream; an engine bump means coordinated binding releases; internal modules keep i18n keys in the
  shared catalog while consumer modules ship locale JSON through the layer deep-merge; each converted
  area lands `data-testid` coverage and live-push e2e specs before the refactor; modules here are
  non-routed; `workspace.applySnapshot` and `useWorkspaceStream.onMessage` stay out of scope until a
  dedicated event-fan-out initiative.
