# Initiative: one overlay shell per job (the SPA macro layer)

**Status:** items 1 and 2 in review · **Owner:** frontend · **Started:** 2026-10-12

> Tracker for a multi-PR initiative. Read it before you start an item, and update the checklist at
> the end of each PR. This is the "Later phase" of
> [kibertoad/cat-factory#2246](https://github.com/kibertoad/cat-factory/issues/2246) (SPA
> consistency on Nuxt UI), after its micro slices landed.

## Goal and rationale

The SPA has five different shells for one job: show a surface over the canvas. It also builds
sub-navigation in three ways. Each shell has its own chrome and, worse, its own behaviour: some trap
focus and some do not, some register on the overlay stack and some listen for Escape on the window.
So the same key does different things on two surfaces that look the same.

The product decision that held this back is settled. In
[#2258](https://github.com/kibertoad/cat-factory/issues/2258) the queue became the entry point and
the board stays as a view, and
[#2325](https://github.com/kibertoad/cat-factory/pull/2325) built the queue as an overlay over the
canvas, not as a route. The SPA stays single-route with overlays, so this initiative consolidates
overlays. It does not move surfaces to routed `UDashboardGroup` pages.

Inventory on `origin/main`, 2026-10-12, under `frontend/app/app/components/`:

| Shell                          | Count      | Behaviour today                                                                                                                                    |
| ------------------------------ | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Centered modal (`UModal`)      | 56 files   | Reka dialog: own focus trap and layer stack. 1 fullscreen (`guidedReview/GuidedReviewModal.vue`)                                                   |
| `panels/ResultWindowShell.vue` | 23 windows | `useModalBehavior` (`@modular-vue/core`): focus trap, focus return, body lock, shared overlay stack                                                |
| Full-bleed takeover            | 7          | Roots share `FULL_BLEED_TAKEOVER_CLASS` (`utils/safeArea.ts`). Only the lightbox used `useModalBehavior`; six hand-rolled a window Escape listener |
| Slideover                      | 1          | `pipeline/PipelineBuilder.vue`, left side                                                                                                          |
| Bottom sheet                   | 2          | `panels/InspectorPanel.vue`; the `panels/AgentStepDetail.vue` review rail below `lg`                                                               |

## Target pattern

- **One shell per job, and the shell owns the behaviour.** A surface renders inside its shell and
  keeps only its own layout. It never adds a key listener for Escape, a focus trap or a body lock.
- **One overlay stack.** Every overlay that is not a Reka layer registers on `sharedOverlayStack`
  through `useModalBehavior`. A Reka layer (every Nuxt UI menu, select, popover and modal) holds a
  ticket for as long as it is open, through `utils/foreignLayers.ts`, so one opened inside a shell
  is the top overlay and keeps its own Escape. No site pushes a ticket by hand.
- **A guard per shell.** `scripts/check-frontend-safe-area.mjs` refuses a hand-written full-screen
  `fixed` surface, and refuses a root class list named outside its owning shell
  (`FULL_BLEED_TAKEOVER_CLASS` belongs to `common/TakeoverShell.vue`, `WINDOWED_OVERLAY_CLASS` to
  `panels/ResultWindowShell.vue`).

Pilot: item 1, `common/TakeoverShell.vue`
([#2354](https://github.com/kibertoad/cat-factory/pull/2354)).

## Checklist

### 1. Full-bleed takeovers on one shell

- [ ] `common/TakeoverShell.vue` on `useModalBehavior`, and all seven takeovers inside it: the step
      reader, the model configuration takeover, the observability, reports, operator dashboard and
      Kaizen panels, and the artifact lightbox. Guard extended. E2e `takeover-shell.spec.ts`.
      [#2354](https://github.com/kibertoad/cat-factory/pull/2354).

Decision: a shell on `useModalBehavior`, not `UModal fullscreen`. `UModal` is the Nuxt UI answer
and gives a focus trap for free, but a Reka modal makes the rest of the page inert while it is open:
it sets `pointer-events: none` on `<body>`, pulls focus back on any `focusin` outside its content,
and dismisses on a pointer or focus outside. The surfaces that open over a takeover
(`ResultWindowShell` windows from the step reader, the lightbox, the observability panel, modular
overlays) are not Reka layers, so they would open unclickable and lose focus to the takeover below.
Each takeover also keeps its own header, `Teleport` and `Transition`; the step reader's fade is owned
by its mount in `pages/index.vue`, which a portal inside `UModal` would break.

### 2. Named overlay widths

- [ ] `common/AppModal.vue` and three named widths in `utils/overlaySize.ts`, grouped by content:
      prompt 448px (11 modals), form 576px (31), wide 672px (4). The ten workbench surfaces keep their
      widths behind a `workbench-width-ok:` comment until item 4. Guard
      `scripts/check-frontend-geometry.mjs`.
      [#2361](https://github.com/kibertoad/cat-factory/pull/2361).

Decision: group by content, not by the old width. The first grouping (prompt 512px, form 672px) kept
each modal near its old width and was too wide for the content. The value is maintenance (one name
per size and a guard), not a visible change.

### 3. One sub-navigation pattern

- [ ] One way to switch between views inside a surface. Today 9 panels use `UTabs`, about half of them
      with icons (for example `panels/ObservabilityPanel.vue`, `settings/WorkspaceSettingsPanel.vue`).
      The GitHub panel, guided review, the fragment library and the view switcher build tabs from
      `UButton` rows. About 15 more `UButton` rows are option pickers, not navigation. They are a
      separate question (`URadioGroup` or a segmented control) and are out of scope here.

### 4. Settings and detail panels as slideovers, and the workbench surfaces

- [ ] Waiting on a decision:
      [#2359](https://github.com/kibertoad/cat-factory/issues/2359). Nuxt UI's overlay matrix puts
      settings and detail in a `USlideover`; the SPA is single-route, so routed pages are out. The
      issue lists the options (keep the shells, settings in a right slideover, one workbench shell on
      `TakeoverShell`, detail as a slideover, routed workbench pages) and suggests settings in a
      slideover plus one workbench shell. It also records a bug that needs a fix whatever the
      answer: the model configuration opened from the pipeline builder (a Reka slideover) cannot be
      clicked, because the slideover sets `pointer-events: none` on `<body>`.

### Not in scope: `ResultWindowShell` stays as it is

`ResultWindowShell` already runs on `useModalBehavior`, so it has the behaviour this initiative
wants. Its chrome is shared by 23 windows, and it also owns the universal trailing sections (effort,
validation, reproduction, binary outputs) and the whole-run fetch. Moving it onto `UModal` would buy
nothing in behaviour and would bring back the Reka conflict above for the lightbox it hosts. It stays
until item 4 decides what a detail surface is.

## Gotchas

- **A hand-rolled Escape listener ignores the stack.** `onKeyStroke('Escape')` from `@vueuse/core`
  listens on the window, so every open takeover closed on one key press. With the observability
  panel over the step reader, Escape closed both. With the shared confirm over the model
  configuration, Escape closed the panel under the confirm.
- **Activate the behaviour on mount, not in setup.** The takeovers are async views. On the first
  open, Nuxt's `Suspense` defers the mount, and `useModalBehavior` moves focus on the tick after
  activation. Activated in setup, it found no element and focus stayed on the board. `TakeoverShell`
  drives `active` from an `onMounted` flag. `ResultWindowShell` activates from its `open` prop in
  setup, so an async window can have the same gap on its first open: check it when you touch that
  shell.
- **Reka keeps its own layer stack, and a prevented Escape is not its key.** Every Nuxt UI menu,
  select, popover and modal is a Reka layer. Reka listens for Escape on the window, after the
  shell's capture-phase listener, and dismisses only an Escape that is not `defaultPrevented`. So
  with a dropdown open inside a takeover, the shell took Escape and prevented it: in the model
  configuration editor, Escape backed out to the preset list and dropped the draft. Making the
  shell listen later does not help, because Reka never prevents the key. The fix is one stack:
  `utils/foreignLayers.ts` gives each open, focus-taking Reka layer a ticket in open order, and a
  tooltip (a layer with no role) none, so the Tab trap under it stays on. An upstream doc change and
  helper for this interop are proposed for `kibertoad/modular-react`.
- **A listener that reads the stack must read it before the overlay it guards closes.**
  `BlockFocusView` holds a ticket on the shared stack while mounted and takes Escape only when it is
  the top one. A step reader opened from it closed on the same key press as the focus view when the
  focus view listened in the bubble phase, because by then the reader's unmount could already have
  released its ticket. Its listener is now registered in the capture phase at setup, so it runs
  before the listener of any overlay opened later. `result-window-shell.spec.ts` asserts it stays
  open under a window's Escape. Whether it should be a shell surface at all belongs with item 4.
- **Stack order and paint order must be the same order.** Every takeover paints at `z-50` inside
  `TakeoverShell`, teleported to `<body>` on open, so DOM order is open order. A per-site z-index
  let a later-opened `z-50` takeover win focus and Escape while painting under an earlier `z-[60]`
  one.
- **A takeover cannot be opened over a Reka modal that stays open.** The modal's focus scope pulls
  every `focusin` outside its content back, so the takeover's initial focus and Tab trap lose.
  Close the modal first, as `PipelineBuilder` does before opening the model configuration.
- **Shift+Tab from the dialog root.** The root is not the first control, so the upstream trap lets
  the first Shift+Tab walk out to the board. `TakeoverShell` wraps it to the last visible control.
- **The focus trap counts hidden controls.** `trapTabFocus` (`@modular-frontend/core`) builds its
  list from a selector and does not skip `display: none` controls, such as the step reader's outline
  below `md` (`hidden md:flex`). When the first or last control in that list is hidden, the wrap calls
  `focus()` on an element that cannot take it. Focus does not leave the dialog, but the wrap does
  not move it either. This is from reading the code; no test covers it yet. `TakeoverShell`'s own
  Shift+Tab wrap from the root does skip hidden controls.
