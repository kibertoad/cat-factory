# Upstream request (modular-react / modular-vue): a Vue **overlay host** binding (`OverlayOutlet`) — module-contributed, app-state-keyed modal windows with framework-managed chrome behaviour, rendered outside routes

**For:** the modular-react maintainers (`@modular-frontend/*` engine + `@modular-vue/*` bindings + `docs/`).
**From:** the cat-factory frontend team, driving [modular-vue adoption slice 5 ("Agent-run window chrome")](./modular-vue-adoption.md).
**Type:** a **pick-one, app-state-keyed overlay host** primitive — the modal/dialog sibling to slice 4's render-all [`PanelsOutlet`](./modular-vue-slice4-upstream-zones.md), made **subject-keyed and route-free**, plus the carry-over peer-range widen tracked since slice 2. Additive; no breaking changes to existing packages.
**Status:** 🟡 **PROPOSED — awaiting upstream release.** cat-factory develops the slice-5 side (§5) against this API via a temporary `file:` link once a branch exists, and bumps to the published `@modular-vue/*` pins with no shim when it lands, per the co-evolution protocol.

> Self-contained by design — read it without cat-factory context. The initiative tracker's slice-5 row points here. It mirrors the slice-2 spec ([`modular-vue-slice2-upstream-pairing.md`](./modular-vue-slice2-upstream-pairing.md)), slice-3 spec ([`modular-vue-slice3-upstream-journeys.md`](./modular-vue-slice3-upstream-journeys.md)), and slice-4 spec ([`modular-vue-slice4-upstream-zones.md`](./modular-vue-slice4-upstream-zones.md)), all three of which shipped essentially as written.

---

## 1. Context — the consumer pressure

cat-factory is a Nuxt SPA (`ssr: false`) adopting modular-vue as a phased strangler migration. Slices 0–4 landed: the registry factory in the layer (slice 0), a nav/command manifest on `useReactiveSlots` (slice 1), a result-view **component registry** + remote-capability pairing (slice 2), journey-hosted wizards (slice 3), and the subject-keyed **render-all panels** primitive that dissolved the block-inspector `v-if` monolith (slice 4). **Slice 5 converts the app's biggest remaining hand-rolled surface — the ~18 agent-run "result windows" — into module-contributed windows composing one framework-managed modal shell.**

### The surface today

A "result window" is a full-screen modal that opens when a human inspects a pipeline step or block: the requirements-review loop, the test report, the merger verdict, the fork-decision picker, the gate views, the brainstorm/clarity/spec/initiative windows, and so on. Slice 2 already made them a **pick-one component registry**:

- **Selection is single-active.** A `ui.resultView` ref (`{ view, blockId, instanceId, stepIndex, stage? }`, exactly one set at a time) names the active window by its `resultView` **id**; `dispatchStepView(instanceId, stepIndex)` resolves a step's `agentKind` → `agentKindMeta(kind).resultView` and sets it.
- **Every window is a `ComponentEntry` in the `resultViews` slot**, and a single host — `StepResultViewHost.vue` — reads the merged slot via `useReactiveSlots`, indexes it with the slice-2 `resolveComponentRegistry`, and mounts `registry.get(ui.resultView.view)` as `<component :is="active" />`. **The pick-one selection is solved. The host mounts exactly one window.**
- **Each window resolves the same shared open/close contract** via a `useResultView(viewId, { onOpen?, onClose? })` composable: `open` (is this the active view), `blockId`/`instanceId`/`stepIndex`, `close()`, load-on-open, and a **global `window` keydown Escape listener registered per window**.

### What is NOT solved — the duplicated modal _behaviour + chrome_

The **selection** is a registry; the **hosting** is not. Each of the ~18 windows still owns, and copy-pastes, its own dialog chrome and modal behaviour. The wrapper is near-identical 18 times:

```html
<Teleport to="body">
  <div
    v-if="open"
    class="fixed inset-0 z-50 flex … bg-slate-950/70 backdrop-blur-sm"
    @click.self="close"
  >
    <div
      class="… w-full max-w-3xl … rounded-2xl border bg-slate-900 shadow-2xl"
      role="dialog"
      aria-modal="true"
      data-testid="…-window"
    >
      <header class="flex items-center gap-3 border-b … px-5 py-3">
        <span class="… icon badge …"><UIcon :name="meta.icon" /></span>
        <div class="min-w-0 flex-1">
          <h2>{{ title }}</h2>
          <p>{{ subtitle }}</p>
        </div>
        <!-- optional: <StepRestartControl>, a status <UBadge> -->
        <button @click="close"><UIcon name="i-lucide-x" /></button>
      </header>
      <!-- bespoke body -->
    </div>
  </div>
</Teleport>
```

Two variants differ only in a handful of classes (variant A "stretch": `items-stretch`; variant B "centered": `items-center … p-4`, `max-h-[90dvh]`) and in the per-window `max-w-*`, header icon/title/subtitle, an optional `StepRestartControl`, and the presence/placement of a `data-testid`.

The problem is not only the ~18× duplication — it is that the **modal behaviour is re-implemented per window and is inconsistent**, which no amount of copy-paste discipline fixes:

| Behaviour                         | State across the ~18 windows                                                                                                                                                                                               |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Focus trap / focus return**     | Implemented in **only 2 of 18** (`TestReportWindow`, `VisualConfirmationWindow`, via a local `useFocusTrap`). The other 16 do not trap focus — a real a11y defect.                                                         |
| **Escape to close**               | Every window registers its **own global `window` keydown** listener in `useResultView`. Correct today (single-active), but N listeners for one modal surface, and no stack awareness for a window that opens a sub-dialog. |
| **z-index / stacking**            | Every window hard-codes `z-50`. A window that opens a nested overlay (the lightbox, a confirm) has no managed stack context — nesting relies on luck.                                                                      |
| **Backdrop click**                | `@click.self="close"` — identical everywhere (the one thing that is consistent).                                                                                                                                           |
| **`role`/`aria-modal`/labelling** | Mostly present, but `MergerResultView` omits `role="dialog"`; `aria-labelledby` is wired nowhere.                                                                                                                          |
| **`data-testid`**                 | On the backdrop in 2 windows, on the dialog root in 5, absent in ~10, never on the close button — the e2e suite can't rely on a stable modal selector.                                                                     |

This is the "hand-rolled structure in a standardization target" the initiative exists to kill (tracker Problem 2, "Agent-run details … each duplicates its dialog chrome"). And it is the **extensibility ceiling** (tracker Problem 1): a **consumer deployment** that ships a custom agent kind with its own result window (the backend already supports custom kinds end-to-end) must re-derive all of this chrome + behaviour by hand, or fork/import an app-internal shell — there is no framework surface that gives a contributed window correct, consistent modal behaviour for free, the way slice 1 gives it a nav slot and slice 4 gives it an inspector panel.

### Correcting the slice-4 prediction

The slice-4 spec (§5.6) anticipated slice 5 would "reuse the render-all panels primitive keyed by the selected step." The survey shows that is only a **secondary** fit and the primary need is different:

- The windows are **pick-one** (one open at a time), not **render-all** — the panels primitive renders _every_ matching entry, which is the wrong reduction for selecting one active window.
- The subject is **not uniformly the step**: 11 windows key on the step (`instanceId`+`stepIndex`), but **7 key on the block** (`blockId` only). "Keyed by the selected step" doesn't hold for a third of the surface.

So the primary primitive slice 5 needs is a **pick-one overlay HOST that manages modal behaviour**, keyed by whatever app state names the active window — a distinct primitive from render-all panels. The slice-4 panels primitive is still reused, but only as a **secondary** application: the cross-cutting header/meta regions that recur across windows (`StepRestartControl` appears in 7, `StepRunMeta` in 7) become a render-all panel group keyed by the step, hosted _inside_ the shell. That reuse needs no new upstream — it is exactly `PanelsOutlet` from slice 4.

## 2. What exists today, and exactly where it stops short

Current published versions (all installed in cat-factory):

| Package                    | Version      | Role                                                                                                                                                                                         |
| -------------------------- | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@modular-frontend/core`   | `0.4.0`      | Neutral engine: modules, slots, navigation, DI, remote manifests, `resolveComponentRegistry`/`pairById` (slice-2 pairing), `definePanelGroup`/`resolvePanels`/`PanelEntry` (slice-4 panels). |
| `@modular-vue/core` `/vue` | `1.3.0`      | Vue bindings: modules, slots (`useReactiveSlots`), nav, DI, pairing re-exports, `PanelsOutlet`/`usePanels`/`usePanelSubject`.                                                                |
| `@modular-vue/runtime`     | `1.4.1`      | Registry runtime (`createRegistry`, reactive slots resolution).                                                                                                                              |
| `@modular-vue/journeys`    | `1.3.0`      | Vue journeys binding (slice 3).                                                                                                                                                              |
| `@modular-vue/nuxt`        | `0.4.0`      | Nuxt install — `installModularApp` (modules + slots + nav + DI + journeys + panels).                                                                                                         |
| **overlay / dialog host**  | **— (none)** | **Does not exist.** No package exposes a module-contributed, app-state-keyed, framework-managed modal host.                                                                                  |

The four primitives that _look_ adjacent each stop short in a specific, load-bearing way:

### Gap A — pick-one **selection** exists, pick-one **hosting with managed chrome** does not

Slice 2's `resolveComponentRegistry`/`pairById` **selects** one component by id — that is done, and slice 5 keeps using it. What is missing is the **host**: a component that takes the selected window and renders it inside a **managed modal shell** — Teleport target, backdrop, `@click.self` close, Escape (one stack-aware listener, not one per window), focus-trap + focus-return, scroll-lock, z-index/stack context, `role`/`aria-modal`/`aria-labelledby`. Today each window re-implements that shell inline, inconsistently (§1). Pairing is a _lookup_; an overlay host is a _managed mount_. Different primitive.

### Gap B — **panels** are render-all + inline; an overlay is pick-one + Teleported + modal

Slice 4's `PanelsOutlet` renders _every_ contribution whose `when(subject)` passes, **inline** in the document flow, with no modal semantics. An overlay is the opposite reduction on two axes: it renders **one** active entry (pick-one, not render-all) and it renders it **as a modal** (Teleported, focus-trapped, scroll-locked, stacked). `PanelsOutlet` can't be bent into this without re-writing exactly the shell behaviour that is missing. It is a deliberately different primitive — the pick-one, modal sibling of the render-all, inline panels.

### Gap C — no styling-agnostic modal shell a **module-contributed** window composes

There is no headless modal primitive in the family. So a first-party OR consumer window that wants correct modal behaviour must either import an app-internal `ResultWindowShell` (couples the consumer to `@cat-factory/app` internals — a forking pressure) or re-derive focus-trap/escape/scroll-lock/stacking/a11y by hand (which is why 16/18 don't trap focus). The framework should own the **behaviour** (headless), leave the **styling** to the app (slots/class props), and aggregate window contributions across first-party + consumer modules — the same seam slots/panels/nav use.

### Gap D — carry-over peer-range drift

The slice-2 and slice-4 residuals are still open: `@modular-vue/{vue,runtime,nuxt}` peer-range `@modular-frontend/core@^0.1.0 || ^0.2.0 || ^0.3.0` while the family is on `0.4.0` (installing `0.4.0` emits a benign unmet-peer warning), and `@modular-frontend/journeys-engine@1.8.0` deps `@modular-frontend/core@0.3.0`, which drags a second copy of the neutral core in beside `0.4.0` (cat-factory pins one copy via a `@modular-frontend/core: 0.4.0` override). A new overlay primitive should peer/dep the current core from birth, and the existing bindings + the journeys engine should be widened in the same release train, closing both residuals at once.

## 3. Design principle — a headless, module-aware, subject-keyed overlay host

The reference is slice 4's panels primitive, run through the pick-one/modal reduction. The contract bottoms out in the neutral engine where selection logic belongs (reusing slice-2 pairing), and the Vue binding is a **faithful, idiomatic Vue port** of a modal host: composables return `Ref`/`ComputedRef`; the window body is a slot/component; the subject arrives as a prop and via `provide`; the behaviour is headless (styling supplied by the consumer). It differs from any route-driven surface in the same two dimensions slice 4 needed: the active entry is keyed by a **caller-supplied app-state value** (not the route), and hosting is **route-free** (no `useRoute`/`useRouter` on the baseline path). Maintainers should align names with the existing vocabulary — as slice 4 shipped `definePanelGroup`/`PanelsOutlet` rather than the spec's proposed `defineZone`/`ZoneOutlet`, the names below are a proposal, not an assumed API.

## 4. Proposed upstream changes

### 4A. The overlay host surface — `@modular-vue/vue` (maintainer's call on package placement)

Slice 4 shipped its panels into the existing `@modular-vue/vue` (not a new `@modular-vue/zones`); the overlay host should follow suit unless the maintainers prefer a dedicated `@modular-vue/overlays`. It must provide a **headless, styling-agnostic modal host** + composables, plus the neutral-engine glue.

**Neutral engine (`@modular-frontend/core`)** — the pieces that are pure data/algorithm:

```ts
// @modular-frontend/core

/** A module-contributed overlay window: a body component + presentation metadata,
 *  addressed by `id` (the same id space as the app-state selector — e.g. cat-factory's
 *  `resultView` id). Selection reuses the slice-2 component registry; this type just
 *  carries the extra presentation a managed shell needs (title/icon) so the host can
 *  render standard chrome without the window re-declaring it. */
export interface OverlayEntry<TSubject = unknown> extends ComponentEntry {
  id: string
  component: UiComponent
  /** Optional presentation the managed shell renders in its header. */
  title?: string | ((subject: TSubject | null) => string)
  icon?: string
  /** Optional per-entry chrome hints (max-width bucket, variant); host interprets. */
  meta?: Record<string, unknown>
}

/** Declare a typed overlay host id + subject type. Aggregates `OverlayEntry`s across
 *  all modules (first-party + consumer) into one slot, exactly like a panel group. */
export function defineOverlayHost<TSubject>(slotKey: string): OverlayHostHandle<TSubject>

/** Pure, headless selection: pick the active entry by id (or null). Reuses `pairById`
 *  under the hood so a dangling/duplicate id is reported the same way. Testable with
 *  no DOM. */
export function resolveOverlay<TSubject>(
  entries: readonly OverlayEntry<TSubject>[],
  activeId: string | null,
): OverlayEntry<TSubject> | null
```

**Vue binding (`@modular-vue/vue`)** — the managed host + composables:

```ts
// @modular-vue/vue

/** Render the active overlay for a host, inside a framework-managed modal shell.
 *  Given the host handle + the active id (from app state) + the subject, it:
 *   - resolves the one active entry (`resolveOverlay`),
 *   - Teleports to a configurable target (default `body`),
 *   - renders a backdrop that closes on `@click.self` (emits `close`),
 *   - traps focus within the panel and RETURNS focus to the opener on close,
 *   - locks body scroll while open,
 *   - participates in a managed z-index STACK so nested overlays layer correctly,
 *   - listens for Escape ONCE at the stack level (top overlay closes first),
 *   - wires a11y: `role="dialog"`, `aria-modal="true"`, `aria-labelledby` from `title`,
 *   - injects the subject (prop + `provide`, read via `useOverlaySubject`).
 *  Styling-agnostic: `#backdrop`, `#panel`, `#header`, `#header-extras`, `#default`
 *  (body), `#empty` slots, or class props for the app's shell. No router use. */
export const OverlayOutlet: DefineComponent<{
  host: OverlayHostHandle<any>
  /** The active window id, from app state (cat-factory: `ui.resultView?.view`). */
  activeId: string | null
  /** The subject threaded to the body + provided (cat-factory: the step or block). */
  subject?: unknown | null
  /** Teleport target; default 'body'. */
  to?: string
  /** How to key the mounted body per subject (default: identity of `subject`). */
  subjectKey?: (subject: unknown) => string | number
}>

/** Read the subject provided by the enclosing OverlayOutlet (for nested body content). */
export function useOverlaySubject<TSubject>(): Ref<TSubject | null>

/** OPTIONAL low-level escape hatch: the same managed modal BEHAVIOUR (focus-trap,
 *  focus-return, scroll-lock, escape, stack registration, a11y wiring) as a composable,
 *  for a window that needs a bespoke root but still wants correct behaviour. Returns
 *  `{ dialogRef, close, isTop }`. This is what a fully custom window uses instead of
 *  re-deriving @vueuse focus-trap + a global keydown by hand. */
export function useModalBehaviour(opts: {
  active: MaybeRefOrGetter<boolean>
  onClose: () => void
  initialFocus?: MaybeRefOrGetter<HTMLElement | null>
}): { dialogRef: Ref<HTMLElement | null>; isTop: ComputedRef<boolean> }
```

Semantics that must hold (the load-bearing ones cat-factory relies on):

- **Pick-one, not render-all.** `OverlayOutlet` mounts _the one_ entry whose id equals `activeId`; `null` renders `#empty` (nothing). (Contrast `PanelsOutlet`, which renders every matching entry.)
- **Managed modal behaviour, uniform.** Focus-trap + focus-return, scroll-lock, one stack-aware Escape listener, a z-index stack context, and a11y wiring are provided by the host — a contributed window inherits all of it and cannot forget it (fixing the 2/18-trap-focus defect structurally).
- **Styling-agnostic.** The host renders no opinionated CSS; the app supplies the backdrop/panel/header look via slots or class props. cat-factory's `ResultWindowShell` is thin styling over this.
- **Subject-reactive + injected two ways.** Changing `subject` re-renders and re-keys; the body reads it as a prop AND via `useOverlaySubject` (no prop-drilling), keyed per subject so no state bleeds across opens — the `usePanelSubject` guarantee, for a pick-one modal.
- **Route-free baseline.** No `useRoute`/`useRouter` on the default path (§4B).
- **Module-contributed.** Windows are declared on module descriptors (`defineModule({ overlays: { resultViews: [...] } })`) and aggregated across first-party AND consumer modules, so a consumer contributes a window with correct chrome through `registerAppModule` with zero host edits.
- **Selection reuses slice-2 pairing.** `resolveOverlay` is `pairById` specialized to the active id — the neutral engine does not grow a second, divergent id-matcher.

Ship a **`@modular-vue/vue` overlay testing entry** (a headless resolver: given entries + an active id + a subject, assert the selected entry) so a consumer can unit-test its overlay wiring without a DOM — the initiative requires unit + e2e coverage per slice.

### 4B. Route-free hosting (the named upstream item)

Make the **no-route, state-hosted** path first-class and documented, not merely possible:

1. `OverlayOutlet`/`resolveOverlay` must work with **zero router involvement** — the active entry is a pure function of `(registered entries, activeId)`; nothing reads the URL. (cat-factory drives `activeId` from a `ui`-store computed.)
2. An **opt-in** route-sync helper is fine for the routed case but must not sit on the baseline import path (mirrors journeys' `useJourneySync` and the slice-4 panels' route-free default).
3. A documented **modal-window recipe** (§4F): a host that supplies app styling + `<OverlayOutlet :host :active-id :subject>`, with the "consumer contributes a window for a custom kind" story shown end to end.

### 4C. Subject typing + selection reuse

- `defineOverlayHost<TSubject>(slotKey)` carries the subject type so `title(subject)` and the body's `useOverlaySubject<TSubject>()` are checked against it.
- The subject is deliberately **caller-supplied and heterogeneous** — cat-factory passes a step (`{instanceId, stepIndex}`) for 11 windows and a block for 7. The host must not assume a single subject shape; `TSubject` is per-host, and `subject` may be `null` (an off-path open with only a block id). A window that ignores the subject (reads its own store by `blockId`) simply doesn't call `useOverlaySubject`.
- Selection **must reuse** slice-2's `pairById` semantics (dangling id → reported, duplicate id → throws) rather than a new matcher, so the diagnostics a consumer already knows carry over.

### 4D. Version alignment (Gap D)

- The overlay surface peer/deps `@modular-frontend/core@^0.4.0` from birth.
- Widen `@modular-vue/{vue,runtime,nuxt}`'s `@modular-frontend/core` peer range to include `^0.4.0`, and bump `@modular-frontend/journeys-engine`'s core dep to `^0.4.0`, in the same release train — closing the slice-2 and slice-4 residuals so cat-factory can drop its `@modular-frontend/core: 0.4.0` override. `pnpm peers check` must be clean in a Vue-family tree that also installs the engine.
- Follow the library's version-coordination policy (`docs/vue-support-tracker.md`) for the coordinated engine→binding release.

### 4E. Nuxt integration — overlays through `installModularApp`

`installModularApp` already wires modules/slots/nav/DI/journeys/panels. Extend it so a registry built with an overlay plugin makes the resolved **overlay manifest** available to `<OverlayOutlet>` from context (a `provide`, like `provideSlots`/`provideNavigation`/the journeys + panels provides), so a Nuxt-layer consumer doesn't hand-thread it. Keep it opt-in (an app with no overlays registered is unchanged), and flow the registry's plugin-extension type through so `manifest.overlays` is typed rather than cast (the same typing win the slice-3 `nuxt@0.3.0` change delivered for journeys). cat-factory's `ssr: false` singleton-registry case is the simple one.

### 4F. Docs

- **`docs/overlays-vue.md`** — the Vue overlay guide: `defineOverlayHost`, `<OverlayOutlet>`/`useOverlaySubject`/`useModalBehaviour`, the pick-one + subject + managed-chrome model, reactivity + injection + stacking rules, and the **pick-one-modal vs render-all-panel** distinction from the slice-4 panels guide.
- **A state-hosted modal-window recipe** (§4B) — app styling + `<OverlayOutlet>`; a consumer contributing a window for a custom kind; preserving host-owned regions (a header-extras slot).
- Cross-link from `framework-mode-nuxt.md`'s consumer-seam section and the panels + remote-manifest guides so readers pick the right primitive (render-all panel vs pick-one modal vs backend-driven manifest).

## 5. How cat-factory will consume it (so the API is validated against a real shape)

Once released, slice 5 lands on the cat-factory side:

1. **A thin `ResultWindowShell.vue` wraps `<OverlayOutlet>`** with cat-factory styling (the backdrop/panel/header look, the two `max-w-*`/centering variants as props). It supplies the app CSS; the framework supplies Teleport + focus-trap + focus-return + scroll-lock + escape + stacking + a11y. `StepResultViewHost.vue` composes the shell + outlet, driving `active-id` from `ui.resultView?.view` and `subject` from the resolved step/block — the pick-one selection stays exactly the slice-2 registry it is today.
2. **Each of the ~18 windows drops its `<Teleport>`/backdrop/header/close chrome** and becomes a body + presentation metadata (`title`, `icon`, an optional `#header-extras` for `StepRestartControl`/status badges). `useResultView` keeps the `open`/`blockId`/`close`/load-on-open contract but **sheds its per-window global Escape listener** (the shell owns Escape now). A window keeps reading its own store by `blockId` (the 7 block-keyed windows) or reads the injected step via `useOverlaySubject` (the 11 step-keyed ones).
3. **The shared header/meta regions reuse slice 4's panels primitive** (`StepRestartControl` in 7 windows, `StepRunMeta` in 7) as a render-all panel group keyed by the **step**, hosted inside the shell's header — so a consumer can add a cross-cutting header control to every agent-run window without editing the shell. This is the secondary panels reuse the slice-4 spec anticipated, now correctly scoped to the shared regions rather than the window selection.
4. **A consumer deployment contributes its own result window** for a custom agent kind by contributing an `OverlayEntry` to the same overlay host via `registerAppModule` (paired against the kind's `presentation.resultView` id, exactly like the slice-2 built-ins) — and it inherits correct modal chrome + behaviour with **zero host edits and zero re-derived focus/escape/scroll code**. This is the slice-5 extensibility promise, dogfooding the exact seam consumers use.
5. **`data-testid`s are preserved and standardized.** The shell emits a stable `data-testid` on the backdrop, dialog root, and close button (which today drift or are absent), so the e2e suite gains a reliable modal selector; each window's inner testids are unchanged. A live-push e2e spec covers the result-window open/close + a step-keyed window's live update before the refactor (e2e-first).
6. **The full-bleed `AgentStepDetail` + `ObservabilityPanel`** (driven by separate `ui` state, `<Transition>`-wrapped, no backdrop-click) are a **looser fit** and are explicitly deferred (§7) — they can adopt the `useModalBehaviour` composable later for consistent focus/escape without forcing the centered-card shell.

The reflection (what fit / what bent) and any residual bends go in the slice-5 PR description and the tracker's slice-5 row, per the co-evolution protocol.

### Why not just a local `ResultWindowShell.vue` (and skip upstream)?

A purely-local shell would collapse the 18× duplication — but it would **not** be the best solution, and it would violate the initiative's own rules:

- The missing piece is **modal behaviour** (focus-trap + focus-return, scroll-lock, stack-aware escape, z-index stacking, a11y) hosted for **module-contributed** windows. That is framework-shaped — the pick-one sibling of slice 4's `PanelsOutlet` — not app styling. Hand-rolling it in cat-factory is "the local shim that reimplements a missing library primitive" the initiative forbids (the exact argument that moved panels upstream in slice 4).
- A local shell can't give a **consumer's** window correct chrome without exporting an app-internal component — reintroducing the forking pressure the whole initiative removes.
- Every prior slice (2, 3, 4) filed its framework-shaped gap upstream and re-adopted the release before closing; slice 5 doing otherwise would be inconsistent. The **styling** stays local (`ResultWindowShell`); the **behaviour + hosting** belongs upstream.

## 6. Acceptance criteria

- The overlay surface is published and `import { OverlayOutlet, useOverlaySubject, useModalBehaviour } from '@modular-vue/vue'` (+ `defineOverlayHost`/`resolveOverlay`/`OverlayEntry` from `@modular-frontend/core`, re-exported by `@modular-vue/core`) type-checks and works at runtime in a Vue/Nuxt `ssr: false` app.
- `<OverlayOutlet :host :active-id :subject>` with **no router**: renders the **one** entry whose id matches `activeId` inside a managed modal shell — Teleported, backdrop-click-to-close, focus-trapped with focus-return, scroll-locked, stack-registered, a11y-wired — with the subject injected as a prop and via `provide`. `activeId = null` renders `#empty`. Unit- and e2e-demonstrated.
- **Pick-one, not render-all**: two entries registered, one active id → exactly one renders; verified distinct from `PanelsOutlet`'s render-all.
- **Managed behaviour is uniform + structural**: a contributed window inherits focus-trap/focus-return/scroll-lock/escape/stacking without opting in; a nested overlay layers above and closes first on Escape. Test-covered.
- **Subject-reactive + injected**: changing `subject` re-renders and re-keys; `useOverlaySubject` reads it; a `null` subject is handled. Test-covered.
- **Module-contributed + consumer-extensible**: a window registered by a _consumer_ module through the registry hosts with correct chrome and no host edit. Test-covered.
- A headless testing entry resolves `(entries, activeId) → selected entry` for unit tests.
- `installModularApp` optionally provides the resolved overlay manifest so `<OverlayOutlet>` resolves from context in a Nuxt layer; an app with no overlays registered is unchanged; the extension type flows through (typed `manifest.overlays`, no cast).
- `@modular-frontend/core@^0.4.0` peer/dep alignment; `@modular-vue/{vue,runtime,nuxt}` peer-ranges include `^0.4.0`; `@modular-frontend/journeys-engine` deps `^0.4.0`; `pnpm peers check` is clean (both residuals closed).
- Docs: `overlays-vue.md` + the state-hosted modal-window recipe + the pick-one-modal-vs-render-all-panel contrast, cross-linked from the Nuxt consumer-seam, panels, and remote-manifest guides.
- No breaking changes to existing packages; new surface + additive widens released under the appropriate labels per the library's versioning policy.

## 7. Out of scope

- **Route-driven overlays / `createRoutes` / route-synced modals.** cat-factory is single-route; overlays are state-hosted (§4B). The opt-in route-sync helper (§4B.2) is a nice-to-have, not required.
- **Compositions engine** (`@modular-frontend/compositions-engine`) — not needed; the overlay host stands alone.
- **Backend-delivered (remote-manifest) overlays.** cat-factory's windows are all code-shipped components selected by a wire-delivered `resultView` id (the slice-2 pairing already covers that). A wire-safe "backend contributes a whole window" manifest is a plausible future need but is **not** requested here — keep the first cut code-only.
- **The full-bleed `AgentStepDetail` / `ObservabilityPanel` refactor** — different chrome (full-bleed, `<Transition>`, no backdrop-click) and separate `ui` state; they may adopt `useModalBehaviour` later but are not part of the centered-card shell conversion.
- **The cat-factory-side slice-5 refactor itself** (§5) — cat-factory-local, lands after the release.
- **SSR overlay hosting** — cat-factory is `ssr: false`; the binding need only be SSR-safe in the trivial client-only-mount sense, matching the slice-0/-3/-4 Nuxt hardening.

---

_When this is released, add the overlay pins (+ any bumped `@modular-vue/*` versions) to `frontend/app/package.json` and `minimumReleaseAgeExclude` (namespace we own), drop the `@modular-frontend/core: 0.4.0` override once the residuals close, then land the cat-factory slice-5 side described in §5 and update the slice-5 row in the tracker._
