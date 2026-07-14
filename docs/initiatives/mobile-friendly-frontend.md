# Mobile-friendly frontend — analysis + design tracker

Status: **design only — no implementation yet.** This document is the analysis of what the
SPA (`frontend/app/app`) needs to be genuinely usable on phones and small tablets, plus the
per-item work checklist for the implementation PRs that follow. Findings were verified
against the code at the referenced `file:line` on 2026-07-14 (line numbers drift as the
tree moves — treat them as anchors, not gospel).

## Goal & rationale

The product is a spatial board + a large family of overlay windows, built desktop-first.
Users increasingly want to check pipeline progress, answer review/decision gates, and read
agent output from a phone — the _monitor-and-decide_ loop, not heavy board editing. The
goal of this initiative is:

1. **Nothing broken at 375px** — no clipped layouts, no unreachable actions, no
   iOS focus-zoom jumps, no content hidden behind the home indicator.
2. **The monitor-and-decide loop is comfortable on a phone** — inspector, notifications,
   review/decision windows, and run progress are legible and tappable.
3. **The board is operable on touch** — pan/zoom/drag/select/act all work with a finger,
   even if deep board _editing_ remains a desktop-first activity.

Explicitly **not** a goal (deferred, see section E): a separate mobile app, offline
support, or replacing the spatial board with a bespoke phone-first navigation model.

## Where we already are (don't redo this)

The audit's biggest finding is that **the structural shell is already mobile-adapted** —
prior work established the right patterns, and the remaining gaps are mostly in the fill,
not the frame. Inventory of what already works, because the fixes below must _copy_ these
patterns rather than invent new ones:

- **Viewport meta** exists (`frontend/app/nuxt.config.ts:118`,
  `width=device-width, initial-scale=1`).
- **`useViewport()`** (`app/composables/useViewport.ts`) is the single source of truth for
  responsive JS: `isCompact` (< Tailwind `lg`/1024px), plus the deliberate
  `hasTouch` (`any-pointer: coarse`) vs `isTouch` (`pointer: coarse`) split.
- **Sidebar** is a real off-canvas drawer below `lg` with backdrop, scroll lock, focus
  trap, Escape-to-close (`components/layout/SideBar.vue:123-146`), driven by a
  `lg:hidden` hamburger in the shell (`pages/index.vue:338-347`).
- **Inspector** is a bottom sheet on mobile (`fixed inset-x-0 bottom-0 … max-h-[80dvh]
rounded-t-2xl`), a docked `lg:w-80` panel on desktop
  (`components/panels/InspectorPanel.vue:264,272`). `AgentStepDetail.vue:560` follows the
  same bottom-sheet → `lg:w-96` pattern.
- **Toolbar** caps to the viewport and scrolls (`components/layout/BoardToolbar.vue:132`
  `max-w-[calc(100vw-1rem)] overflow-x-auto`), labels collapse via `hidden sm:inline`.
- **The ~13 hand-rolled result-view windows share one responsive idiom**: `Teleport` →
  `fixed inset-0 flex justify-center` → `w-full max-w-{3xl..5xl} flex-col overflow-hidden
max-h-[90dvh]`, with two-column bodies stacking below `lg`
  (`flex-col lg:flex-row`, e.g. `requirements/RequirementsReviewWindow.vue:565,602`).
- **Board input is touch-engineered on purpose**: one-finger pan via
  `boardPanMode(hasTouch)` (`utils/boardPanMode.ts`, unit-tested — the button-array form
  silently blocks touch, hence the util); pinch-zoom via Vue Flow's d3-zoom with
  `.vue-flow__pane { touch-action: none }` (`assets/css/main.css:40-42`); **all** custom
  drags (block drag, frame resize, dependency connect) are Pointer Events with `touch-none`
  on the handles (`composables/useBlockDrag.ts`, `useFrameResize.ts`,
  `useDependencyConnect.ts`); frame-header buttons already scale
  `:size="isTouch ? 'sm' : 'xs'"` (`board/nodes/BlockNode.vue:472-510`) and the resize
  corner grows to 44px under `pointer-coarse` (`BlockNode.vue:570`).
- **Notifications inbox** caps at `w-[min(24rem,92vw)]`
  (`layout/NotificationsInbox.vue:239`).
- Global CSS is mobile-safe: no fixed body width, `dvh` used for heights, `body
{ overflow: hidden }` makes the app a non-scrolling surface where every secondary
  surface owns its scrolling.

## Target patterns (the design)

Every fix below follows one of these; they are restatements of what the codebase already
does in its good citizens. **Do not introduce a second responsive system.**

- **P-1 — Breakpoint discipline.** `lg` is the compact cutoff (it is what
  `useViewport().isCompact` encodes and what drawer/inspector/windows already use).
  Layout defaults to single-column/stacked and opts _into_ multi-column at a breakpoint:
  `grid-cols-1 lg:grid-cols-[…]`, `flex-col lg:flex-row`. Never a bare `grid-cols-2`.
  For JS decisions use `useViewport()`, never raw `window.innerWidth`/`matchMedia`.
- **P-2 — Touch hit targets.** Interactive board/toolbar controls reach ≥40px on touch via
  the existing `:size="isTouch ? 'sm' : 'xs'"` idiom or `pointer-coarse:` utilities. Any
  invisible grab strip (resize edges) gets a generous `pointer-coarse:` width.
- **P-3 — Input font floor.** No focusable input renders below 16px on mobile (iOS Safari
  auto-zooms the viewport on focus otherwise). Fix centrally: Nuxt UI `:ui` defaults in
  `app.config.ts` (`text-base sm:text-sm` shape) + eliminate the raw `<textarea>`/`<input>`
  outliers in favour of `UInput`/`UTextarea`.
- **P-4 — Safe areas.** `viewport-fit=cover` on the viewport meta, and
  `env(safe-area-inset-*)` padding on every bottom-anchored fixed surface (inspector
  bottom sheet, toasts, drawer). Without the meta change the `env()` vars are always 0, so
  the two land together.
- **P-5 — One window shell.** The ~13 duplicated result-view overlay skeletons converge on
  a single shared `<ResultWindow>` wrapper component (the `useResultView`/
  `StepResultViewHost` seam already unifies the logic side). Cross-cutting mobile concerns
  (safe-area padding, `overscroll-behavior: contain`, the `max-h-[90dvh]` clamp, backdrop/
  Escape handling) then live in ONE place. This is the fix-once seam for most remaining
  window papercuts and the precondition for not re-fixing 13 files per concern.
- **P-6 — Content reflows, it doesn't disappear.** A side rail below `lg` restacks
  (bottom bar / collapsible section, as `RequirementsReviewWindow.vue:602,963` does) rather
  than `hidden lg:flex` — unless its content is genuinely redundant on mobile, which must
  be verified per rail, not assumed.
- **P-7 — Hover is an enhancement, never the only path.** Every hover-/`title`-/dblclick-
  gated affordance needs a tap-reachable equivalent (usually: single-tap select → the
  action lives in the inspector, which several already have).

## Severity legend

- **P1** — broken/unreachable on a phone: clipped layout, unusable control, viewport jump.
- **P2** — materially degrades the mobile experience: illegible density, missed gestures.
- **P3** — polish; low individual impact but compounding.

## Work items

Statuses: `todo` / `in-progress` / `done` (+ PR link). Grouped into the intended PR
slices; each section is roughly one PR.

### A. Foundations (fix-once primitives) — first slice

| ID  | Sev | Item                                                                                                                                                                                                                                                                                                                                                                                                                                     | Where                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Status                                               |
| --- | --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------- |
| A1  | P1  | Add `viewport-fit=cover` to the viewport meta and `env(safe-area-inset-bottom)` clearance to bottom-anchored surfaces: inspector + step-detail bottom sheets, sidebar drawer (padding), and the toaster (added to its `bottom` offset, since its toasts are abs-anchored at `bottom-0` and padding cannot lift them — see gotchas).                                                                                                      | `nuxt.config.ts:118`; `panels/InspectorPanel.vue:264`; `panels/AgentStepDetail.vue:560`; `app/assets/css/main.css` (toaster viewport); `layout/SideBar.vue:142`                                                                                                                                                                                                                                                                                                                                  | **done** (#1087)                                     |
| A2  | P1  | Global input font floor so mobile inputs render ≥16px, neutralizing iOS focus-zoom app-wide. **Implemented as a single fix-once CSS rule** (`@media (pointer: coarse)` floors `input`/`textarea`/`select` at `max(16px, 1em)` in `main.css`) rather than Nuxt UI `:ui` defaults — the CSS seam reaches Nuxt UI's rendered fields _and_ every raw one, and (unlike a component default) cannot be defeated by a per-instance `size="sm"`. | `app/assets/css/main.css`                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | **done** (#1087)                                     |
| A3  | P1  | Sub-16px raw `<textarea>`/`<input>` outliers that bypass a component-default floor. **Subsumed by the A2 CSS rule** — the global coarse-pointer floor covers every raw field (forkDecision/followUp/visualConfirm/humanTest/gates + the untracked PipelineBuilder/InitiativeTracker fields) with no per-file edits.                                                                                                                      | as A2                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | **done** (#1087)                                     |
| A4  | P2  | Extract the shared `<ResultWindow>` overlay shell (P-5) and migrate the ~13 windows onto it; fold in `overscroll-behavior: contain` on the inner scroll containers and safe-area padding.                                                                                                                                                                                                                                                | `requirements/RequirementsReviewWindow.vue`, `clarity/ClarityReviewWindow.vue`, `brainstorm/BrainstormWindow.vue`, `consensus/ConsensusSessionWindow.vue`, `spec/ServiceSpecWindow.vue`, `forkDecision/ForkDecisionWindow.vue`, `followUp/FollowUpWindow.vue`, `humanTest/HumanTestWindow.vue`, `testing/TestReportWindow.vue`, `visualConfirm/VisualConfirmationWindow.vue`, `docs/DocInterviewWindow.vue`, `initiative/InitiativePlanningWindow.vue`, `initiative/InitiativeTrackerWindow.vue` | todo (next slice)                                    |
| A5  | P3  | Mobile head metadata: `theme-color` (match the dark surface) + touch icons. `theme-color` **done**; touch icons need a branded icon asset + a manifest and are folded into E2 (installability). PWA manifest/installability is E2, not this item.                                                                                                                                                                                        | `nuxt.config.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | **partial** (#1087) — `theme-color` done, icons → E2 |

### B. Layout breaks at 375px

| ID  | Sev | Item                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Where                                                                                                                                                                                                                                           | Status   |
| --- | --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| B1  | P1  | `BlockFocusView` full-screen overlay uses a hard `grid grid-cols-[1fr_300px]` with no breakpoint — at 375px the main column collapses to ~0. Restack per P-1: `grid-cols-1 lg:grid-cols-[1fr_300px]`.                                                                                                                                                                                                                                                                                                                                                                                                                                                | `focus/BlockFocusView.vue:120`                                                                                                                                                                                                                  | **done** |
| B2  | P1  | Non-collapsing `grid-cols-2` forms → `grid-cols-1 sm:grid-cols-2` (copy the correct pattern in `LocalModelEndpointsPanel.vue:323`). RiskPolicy's `grid-cols-2 sm:grid-cols-4` became `grid-cols-1 sm:grid-cols-2 lg:grid-cols-4` (collapse fully on phones, keep the 4-up density on wide).                                                                                                                                                                                                                                                                                                                                                          | `settings/BudgetSettings.vue:137`; `settings/WorkspaceSettingsPanel.vue:253`; `settings/RiskPolicyPanel.vue:270,353`; `bootstrap/BootstrapModal.vue:698`                                                                                        | **done** |
| B3  | P2  | KaizenPanel table is wrapped in `overflow-hidden` (clips columns on narrow screens); every other table uses `overflow-x-auto` — make Kaizen match.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | `kaizen/KaizenPanel.vue:154`                                                                                                                                                                                                                    | **done** |
| B4  | P2  | Side rails that `hidden lg:flex` instead of restacking (P-6): verify per rail whether the content matters on mobile; restack the ones that do. **Brainstorm** (rail carries the primary proceed/incorporate/re-run actions — unreachable on a phone otherwise) and **TestReport** (outcome counts / environment / run metadata) now restack as a full-width bottom section below `lg`, copying the `RequirementsReviewWindow` reference (stats collapse, actions stay). **AgentStepDetail** ToC verified redundant on mobile (jump-nav duplicating scrollable prose headings) — kept hidden below `lg`, only normalizing the `md:` outlier to `lg:`. | `brainstorm/BrainstormWindow.vue:502`; `testing/TestReportWindow.vue:845`; `panels/AgentStepDetail.vue:243`                                                                                                                                     | **done** |
| B5  | P2  | 375px inner-column audit of the full-bleed `items-stretch` windows (each has bespoke internal columns that were not individually verified; B1 shows the failure mode). Naturally folds into the A4 migration.                                                                                                                                                                                                                                                                                                                                                                                                                                        | `docs/DocInterviewWindow.vue:72`; `followUp/FollowUpWindow.vue:88`; `forkDecision/ForkDecisionWindow.vue:106`; `humanTest/HumanTestWindow.vue:140`; `initiative/InitiativePlanningWindow.vue:109`; `initiative/InitiativeTrackerWindow.vue:179` | todo     |

### C. Legibility & density

| ID  | Sev | Item                                                                                                                                                                                                                                                                                                                                                                               | Where                                                                                                                                                             | Status |
| --- | --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| C1  | P2  | Sub-12px typography sweep: `text-[10px]`/`text-[11px]` appear ~748 times across ~130 files (eyebrow labels, badges, hints). Define a small shared scale (e.g. an `text-eyebrow`-style utility or agreed replacement classes) that renders ≥12px on compact viewports, then migrate area-by-area — inspector + review windows first (the monitor-and-decide loop), long tail after. | systemic; hotspots: `panels/InspectorPanel.vue:288-384`, `requirements/RequirementsReviewWindow.vue:728,912`, `initiative/InitiativeTrackerWindow.vue` (~25 uses) | todo   |
| C2  | P3  | Density pass on review-window finding cards (badges + selectors + textareas in `p-3` cards with 11px labels): larger tap spacing on compact viewports. Ride the C1 sweep.                                                                                                                                                                                                          | `requirements/RequirementsReviewWindow.vue`, `clarity/ClarityReviewWindow.vue`                                                                                    | todo   |

### D. Board touch ergonomics

| ID  | Sev | Item                                                                                                                                                                                                                                                                                                                                 | Where                                                                    | Status |
| --- | --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------ | ------ |
| D1  | P1  | Task-card action buttons (Start / Review / Merge / Resolve / open-PR) are hardcoded `size="xs"` (~20-24px) — the most-used touch targets on the board. Apply the existing `:size="isTouch ? 'sm' : 'xs'"` idiom (as `BlockNode.vue:472-510` already does).                                                                           | `board/nodes/TaskCard.vue:320,331,361-391`                               | todo   |
| D2  | P2  | Toolbar camera controls (zoom in/out, fit, reset readout) fixed at `size="sm"` (~32px); these are the only camera controls (minimap was deliberately removed). Bump on touch.                                                                                                                                                        | `layout/BoardToolbar.vue:135-190`                                        | todo   |
| D3  | P2  | Frame/module resize edge strips only reach 16px under `pointer-coarse` (`w-4`/`h-4`) while the corner correctly reaches 44px — widen edges to ~`w-8`/`h-8` under `pointer-coarse`.                                                                                                                                                   | `board/nodes/BlockNode.vue:560,565`; `board/nodes/ModuleFrame.vue:83,88` | todo   |
| D4  | P2  | Pipeline expansion at deep zoom is hover-driven (`elementFromPoint` of last `pointermove`) — effectively unavailable on touch (no persistent hover; only the centre-most-card fallback fires). Add a tap-to-pin expansion path (P-7).                                                                                                | `composables/useTaskExpansion.ts:56,68-72,120-127`                       | todo   |
| D5  | P3  | Double-click canvas gestures (focus a task, centre a frame) rely on synthesized `dblclick` — unreliable from double-tap. Inspector Focus button + toolbar fit-view already cover the actions; verify those paths and, if double-tap proves dead on real devices, add an explicit affordance rather than a custom gesture recognizer. | `board/BoardCanvas.vue:105-119`; `panels/InspectorPanel.vue:584`         | todo   |
| D6  | P3  | Truncated titles / dependency labels expose full text only via `title=` tooltips — unreachable on touch. Full text is available in the inspector after tap-select; verify each site has that path and drop/augment the ones that don't.                                                                                              | `board/nodes/TaskCard.vue:258,296,301`; `board/nodes/EpicNode.vue:40`    | todo   |

### E. Deferred (explicitly not committed in this initiative)

| ID  | Item                                                                                                                                                                                                                                                                                                       | Why deferred                                                                                                                                                                                                                                               |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| E1  | A mobile _reading model_ for the board (list/drill-down instead of spatial pinch-zoom). Task cards are fixed 210px (`DraggableTask.vue:31`) and pipeline detail only appears at zoom ≥1.8 (`useSemanticZoom.ts:13-19`), so reading a large board on a phone means constant pinch-panning.                  | Big surface, separate initiative if phone usage becomes primary. The A–D items make the board _operable_ on touch; the inspector + notifications already provide a serviceable non-spatial reading path. Decide after A–D land and real usage is observed. |
| E2  | PWA installability (`@vite-pwa/nuxt`, manifest, offline shell) **+ the touch/home-screen icons and standalone status-bar metas folded out of A5** (they need a branded icon asset + manifest and a top safe-area pass for the standalone status bar, so they belong with installability, not the A-slice). | Independent of layout; only worth it if users actually want home-screen install. A5's `theme-color` already delivers the perceived browser-chrome polish.                                                                                                  |

## Verification strategy

- **Per-slice manual check** at 375×667 (iPhone SE) and 390×844 in devtools device mode,
  plus one real iOS Safari pass for the A1/A2/A3 slice (focus-zoom and safe-areas cannot
  be verified in desktop devtools).
- **e2e**: the Playwright suite (`backend/internal/e2e`) runs desktop-viewport Chromium.
  Once slice A lands, add a small mobile-viewport project (Playwright device preset) with
  a smoke spec: open board → open inspector bottom sheet → open a review window → assert
  no horizontal overflow on `document.documentElement` and key controls visible. Follow
  the suite's rules (`data-testid` selectors only, seed over REST, live-push assertions,
  no fixed sleeps; new test ids are one-line frontend changes + a patch changeset).
- **No screenshot-diff infra** in this initiative — assertion-based checks only.

## Conventions & gotchas (carry between iterations)

- `lg` is the compact cutoff everywhere; `useViewport().isCompact` is the JS mirror of it.
  Do not introduce `md`-based layouts for new mobile work (one existing outlier:
  `AgentStepDetail.vue:243` uses `md:flex` for its rail — normalize when touched).
- `hasTouch` (`any-pointer: coarse`) gates _input capability_ (pan mode); `isTouch`
  (`pointer: coarse`) gates _ergonomics_ (hit-target sizing). Don't conflate them — the
  distinction is deliberate and documented in `useViewport.ts`.
- Any handle that starts a Pointer-Events drag MUST carry `touch-none`
  (`touch-action: none`), or the browser steals the gesture for scrolling — this is why
  the existing drag paths work on touch at all.
- `env(safe-area-inset-*)` evaluates to 0 until the viewport meta carries
  `viewport-fit=cover`; ship the meta change and the padding in the same slice (A1). On
  desktop the insets are 0, so unconditional `pb-[calc(<base>+env(safe-area-inset-bottom))]`
  needs no `lg:` override; use physical `px-*`/`pt-*`/`pb-[…]` (not `p-*`) so the
  bottom-side override never collides with a shorthand.
  - **Padding only lifts an in-flow surface.** The inspector/step-detail bottom sheets and
    the sidebar drawer are in-flow scroll containers, so `pb-[calc(…)]` on their body/footer
    works. The toaster is NOT: each toast is `position: absolute; bottom: 0` inside the
    `data-slot='viewport'`, and an abs child anchored to `bottom-0` tracks the padding-box
    edge (padding-bottom cannot inset it). So the toaster carries the inset on its `bottom`
    OFFSET instead — `bottom: calc(1rem + env(safe-area-inset-bottom))` in `main.css`
    (matching Nuxt UI's stock `bottom-4`). Reach for the offset, not padding, on any
    absolutely-anchored surface.
- iOS focus-zoom triggers on _rendered_ input font < 16px. **This is now fixed once, in CSS**
  (`main.css`, `@media (pointer: coarse)` → `input/textarea/select { font-size: max(16px, 1em) }`),
  which is immune to the `size="sm"` reintroduction trap that a component-default approach
  has — so no per-field vigilance is needed. Do NOT re-add a Nuxt UI `:ui` font-size default
  for this; the CSS rule is the single source of truth. `max(16px, 1em)` floors without
  shrinking a deliberately larger field.
- All user-facing copy added while fixing these goes through i18n per CLAUDE.md (all
  locales in the same PR); every `@cat-factory/app` change needs a changeset.
- Line-number refs in this doc were taken on 2026-07-14 — re-verify anchors before edits.

**When the committed scope (A–D) is complete**, convert this tracker to an ADR under
`backend/docs/adr/` and `git rm` this file, per the CLAUDE.md tracker lifecycle. E-items
that were consciously not pursued go in the ADR's Consequences section.
