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
  focus-move-on-open, `role="dialog"`/`aria-modal`/`aria-label`, an accessible backdrop, and a
  breakpoint-cross reset of `mobileNavOpen`. Hamburger `aria-label` reflects open/closed state.

Verified: `pnpm --filter @cat-factory/app typecheck` clean, `pnpm lint:fix` clean.

## Phase 2 — Touch targets + modal/panel responsiveness — PR 2

- ☐ Enlarge hit targets (task grip, resize edges, connect button, `xs`→`sm` buttons) via `pointer: coarse`.
- ☐ Modals/panels fit small screens (PipelineBuilder, settings/\*, review windows) using `dvh`.
- ☐ Patch changeset.

## Phase 3 — Board canvas touch gestures — PR 3

- ☐ Configure/verify Vue Flow pinch-zoom + one-finger pan; `touch-action: none` on pane.
- ☐ Reconcile block/frame drag vs. pan on touch (`useBlockDrag.ts`, `useFrameResize.ts`).
- ☐ Hide minimap on `< lg`; ensure toolbar zoom/fit fallback reachable.
- ☐ Patch changeset.

---

## Changelog

- **Phase 0 + Phase 1 complete** — responsive shell landed: `useViewport` composable,
  `ui.mobileNavOpen`, sidebar drawer + hamburger, toolbar reflow, inspector bottom sheet,
  notifications width cap, i18n labels, e2e spec + changeset. Typecheck + lint green.
