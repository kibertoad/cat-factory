# Mobile-friendly frontend — phase tracker

Tracking the work to make the `@cat-factory/app` SPA usable on phones. Full design in the
session plan; this doc tracks **status per phase** and is updated as work lands.

**Target:** phones (~375px+), `< lg` (1024px) treated as the "compact/mobile" breakpoint.
**Delivery:** three reviewable phases, one PR each.

Legend: ☐ not started · ◐ in progress · ☑ done

---

## Phase 0 — Shared responsive primitives (folded into Phase 1)

- ☑ `app/composables/useViewport.ts` — `isCompact` (`smaller('lg')`) + `isTouch` (`pointer: coarse`) via VueUse.
- ☑ `app/stores/ui.ts` — `mobileNavOpen` + `open/close/toggleMobileNav()`.
- ☑ `i18n/locales/en.json` — `nav`/`common` labels for new affordances.

## Phase 1 — Responsive shell (sidebar drawer + toolbar + inspector) — PR 1

- ☑ SideBar → off-canvas drawer on `< lg` (slide-in + backdrop, static `w-64` on `lg:`).
- ☑ Hamburger trigger (`lg:hidden`) wired to `ui.toggleMobileNav()`.
- ☑ BoardToolbar reflow — hide zoom-%/LOD label + collapse `Add service`/spend/decision
  labels to icons on `< sm`; pill capped to `max-w-[calc(100vw-1rem)]`. (Chose
  label-collapsing over a kebab menu: keeps every control one tap away.)
- ☑ InspectorPanel → bottom sheet on `< lg` (`max-h-[80dvh]`; existing X is the dismiss),
  docked `w-80` panel on `lg:`.
- ☑ NotificationsInbox popover — capped to `w-[min(24rem,92vw)]`.
- ☑ Patch changeset for `@cat-factory/app` (`.changeset/mobile-responsive-shell.md`).
- ☑ Mobile-viewport e2e spec (`backend/internal/e2e/tests/mobile-shell.spec.ts`) +
  `data-testid`s (`mobile-nav-toggle`, `sidebar`, `sidebar-backdrop`, `inspector-panel`).
- ☑ Drawer a11y/hygiene: `useViewport().isCompact` drives Escape-to-close, body-scroll-lock,
  focus-move-on-open **and focus-restore-to-hamburger on close**, `role="dialog"`/`aria-modal`/
  `aria-label`, an accessible backdrop, a breakpoint-cross reset of `mobileNavOpen`, and `inert`
  on the closed (off-screen) drawer so its controls aren't keyboard/AT-reachable behind the
  board. Hamburger `aria-label` reflects open/closed state.
- ☑ i18n: SideBar nav labels + section headers and the toolbar `Add service` / decision-count
  label lifted into the `nav.*` / `board.toolbar.*` catalog namespaces (the decision count uses
  the vue-i18n pipe-plural form instead of a hand-rolled `?'':'s'`).
- ☑ Inspector bottom sheet sits at `z-20` (below the drawer scrim at `z-30`), so opening the
  nav over a selected task no longer pokes the sheet through the backdrop.

Verified: `pnpm --filter @cat-factory/app typecheck`, `pnpm --filter @cat-factory/app run i18n:check`,
and `pnpm lint` (oxlint + `oxfmt --check`) all clean; the `mobile-shell` e2e spec selects the task
card by its own `data-block-id` (the test id sits on the same element), so the bottom-sheet spec
passes.

## Phase 2 — Touch targets + modal/panel responsiveness — PR 2

- ☑ Enlarge hit targets via the Tailwind v4 `pointer-coarse:` variant (the CSS form of
  `useViewport().isTouch`, so mouse desktops are untouched): the task drag grip
  (`DraggableTask.vue`), the service + module resize edges/corner (`BlockNode.vue`,
  `ModuleFrame.vue`), and the drag-to-connect handle (`TaskCard.vue`). The frame-header
  action buttons (`BlockNode.vue`) bind `:size="isTouch ? 'sm' : 'xs'"` (a prop, so it uses
  the composable rather than the CSS variant).
- ☑ Modals/panels fit small screens using `dvh`. The hand-rolled overlay windows are capped
  to the dynamic viewport — the five centred review windows (requirements / clarity / spec /
  consensus / brainstorm) swap `h-[90vh]`→`max-h-[90dvh]` (a `max-h` so a tiny landscape
  viewport can't push the top of the window out of reach), and every `fixed inset-0` overlay
  (those five plus the `items-stretch` result views: follow-up, test-report,
  visual-confirmation, gate, generic-structured, human-test) gains `max-h-[100dvh]` so its
  controls clear the mobile browser chrome. The Pipeline builder stacks its three columns and
  scrolls as one below `lg` (independent per-column scroll on `lg:`); the two custom
  full-screen panels — `ModelConfigurationPanel` and `AgentStepDetail` — gain `max-h-[100dvh]`
  (on `AgentStepDetail` this is what actually lifts the phase-1 review-rail bottom sheet, an
  `absolute bottom-0` child, above the mobile chrome — capping its height alone didn't move its
  anchor); the rest of `settings/*` are `UModal`s, already height-capped by Nuxt UI's default
  `max-h-[calc(100dvh-2rem)]`. Also swapped the phase-1 `AgentStepDetail` mobile review-rail
  sheet `max-h-[70vh]`→`max-h-[70dvh]`.
- ☑ Patch changeset (`.changeset/mobile-touch-targets.md`).

## Phase 3 — Board canvas touch gestures — PR 3

- ☑ Vue Flow pinch-zoom + one-finger pan. `zoomOnPinch` is on by default; `panOnDrag` is now
  computed from `useViewport().isTouch` — `true` on a coarse pointer, the precise-pointer
  button list `[0, 2]` (left/right-drag, never middle) on mouse. The button-array form
  silently blocked single-finger panning: Vue Flow's d3-zoom filter rejects a `touchstart`
  whose `event.button` (undefined on touch) isn't in the array, so a touch could only pan
  once `panOnDrag` is `true`/unbounded. `.vue-flow__pane` gets `touch-action: none`
  (`assets/css/main.css`) so the browser never reinterprets a pane drag as a page scroll.
- ☑ Reconcile block/frame drag vs. pan on touch. The custom pointer-driven affordances
  (`useBlockDrag` / `useFrameResize` / `useDependencyConnect`) already kept the pane from
  panning via the `nopan` class; the missing piece on touch was the browser stealing the
  gesture as a scroll (firing `pointercancel`). Every handle — the task drag grip
  (`DraggableTask`), the service + module header drag and resize edges/corner (`BlockNode`,
  `ModuleFrame`), and the drag-to-connect handle (`TaskCard`) — now carries `touch-none`
  (`touch-action: none`), so the gesture stays with our pointer handlers. (No composable
  logic changed — they're already `PointerEvent`-based, so they cover touch once the browser
  stops pre-empting them.)
- ☑ Hide minimap on `< lg` (`v-if="!isCompact"` on `<MiniMap>` in `BoardCanvas`); the toolbar
  zoom-out / zoom-in / fit-view controls are the camera fallback (now tagged
  `board-zoom-out` / `board-zoom-in` / `board-fit-view` for the e2e).
- ☑ `mobile-canvas.spec.ts` e2e: at a phone viewport the minimap is hidden and the toolbar
  camera fallback stays reachable. (Touch pan/pinch is Vue Flow config, not driven in e2e.)
- ☑ Patch changeset (`.changeset/mobile-canvas-touch.md`).

---

## Changelog

- **Phase 3 complete** — board canvas touch gestures: one-finger pan via a touch-aware
  `panOnDrag` (the `[0, 2]` button list blocked single-finger panning), pinch-zoom on by
  default, `touch-action: none` on the pane and on every custom drag/resize/connect handle so
  the browser can't steal a gesture mid-drag, and the precise-pointer minimap hidden below
  `lg` with the toolbar zoom/fit controls as the camera fallback. e2e spec + patch changeset
  added. This completes the three-phase mobile-friendly track.
- **Phase 2 complete** — touch targets + modal/panel responsiveness: coarse-pointer hit-target
  enlargement (grip, resize edges, connect handle, frame-header buttons) via the
  `pointer-coarse:` variant, every hand-rolled overlay window + the Pipeline builder + the
  Model Configuration panel capped to the dynamic viewport (`dvh`) so nothing hides behind
  mobile browser chrome, and the Pipeline builder columns stack-and-scroll below `lg`. Patch
  changeset added.
- **Review follow-up** — fixed the bottom-sheet e2e selector (clicked a non-existent descendant
  test id), added `inert` + focus-restore to the drawer, lowered the inspector sheet below the
  drawer scrim, lifted the SideBar/toolbar copy into i18n (pipe-plural decision count), and
  cleared the repo-wide `oxfmt` drift that was failing `Lint & format`.
- **Phase 0 + Phase 1 complete** — responsive shell landed: `useViewport` composable,
  `ui.mobileNavOpen`, sidebar drawer + hamburger, toolbar reflow, inspector bottom sheet,
  notifications width cap, i18n labels, e2e spec + changeset. Typecheck + lint green.
