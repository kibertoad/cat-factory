# Slice 5 progress: agent-run window chrome (`ResultWindowShell`)

**Status:** all 18 windows landed — slice complete (pending the ADR conversion) · **Owner:** frontend · **Parent:** [modular-vue adoption](./modular-vue-adoption.md) · **Upstream spec:** [`modular-vue-slice5-upstream-overlays.md`](./modular-vue-slice5-upstream-overlays.md) (released + adopted)

> Per-window checklist + the reference pattern for slice 5. Read this before picking up
> the next window; tick a row and note anything that bent when you convert it. This is the
> working tracker; it converts to an ADR (or folds into the parent's slice-5 outcomes) when
> the last window lands.

## Goal

The ~18 agent-run result windows each hand-rolled the same modal chrome (`<Teleport>` +
backdrop + bordered card + header + close) AND re-implemented the modal _behaviour_
inconsistently — only 2 of 18 trapped focus, each registered its own global Escape
listener, and every one hard-coded `z-50` with no stacking. Slice 5 centralises the chrome
in one **`ResultWindowShell`** and delegates the behaviour to the upstream `useModalBehavior`
(the slice-5 overlay-host release, `@modular-frontend/core@0.5.0` / `@modular-vue/*@1.4.x`),
converting windows one at a time behind it.

## Reference pattern (the pilot: `MergerResultView`)

Copy this shape for every window. The pilot commit is the worked example.

1. **The shell owns chrome + behaviour.** `app/components/panels/ResultWindowShell.vue`
   renders the `<Teleport>` + backdrop + bordered card + header (icon / title / subtitle /
   `#header-extras` slot / opt-in `StepRestartControl` / close) and calls the upstream
   `useModalBehavior({ active: () => props.open, onClose })` for focus-trap + focus-return,
   body-scroll lock, and the **shared overlay stack** (top overlay closes first on Escape).
   It emits `close`; state stays app-owned.
2. **Selection is unchanged.** `StepResultViewHost.vue` still pick-one-selects the active
   window via the slice-2 `resolveComponentRegistry` — the shell is per-window chrome, so
   windows convert independently with **no host or registry changes** (the shell uses
   `useModalBehavior` directly, which needs no modular-app provide).
3. **A window becomes body-only markup** wrapped in `<ResultWindowShell :open :icon
:icon-class :title :subtitle :step-ref width variant @close="close">…body…</ResultWindowShell>`.
   Drop the window's own `<Teleport>`/backdrop/card/`<header>`/close button.
4. **Keep `useResultView` but pass `manageEscape: false`** so the shell owns Escape (a
   second listener would double-fire `close`). `onOpen`/`onClose` are unchanged.
5. **`stepRef`** — pass `:step-ref="{ instanceId, stepIndex }"` on a step-**result** window
   to surface the shared restart control (self-hides off-path); OMIT it on gates and
   block-keyed windows (no restart mid-gate / pre-run).
6. **`variant` / `width`** — `variant="stretch"` (default) for the full-height windows;
   `variant="centered"` (`p-4`, `max-h-[90dvh]`) for the review windows. `width` ∈
   `3xl|4xl|5xl` matches the window's old `max-w-*`.
7. **`data-testid`s** — the shell emits stable `result-window-backdrop` / `result-window` /
   `result-window-close` hooks. Pass `:testid="<old-id>"` to preserve a window's existing
   dialog id; window-specific inner testids are untouched. Add live-push e2e coverage per
   the e2e rules before/with each conversion.

## Per-window checklist

Attributes from the whole-surface survey (parent tracker's slice-5 row). "Keyed" = the
window's subject; "extras" = header content beyond the standard row.

| #   | Window                        | view id               | keyed               | variant / width | stepRef      | loader (`onOpen`) | draft (`onClose`) | header extras       | preserve testid                                      | status                                                          |
| --- | ----------------------------- | --------------------- | ------------------- | --------------- | ------------ | ----------------- | ----------------- | ------------------- | ---------------------------------------------------- | --------------------------------------------------------------- |
| —   | **`MergerResultView`**        | `merger`              | step                | stretch / 3xl   | yes          | no                | no                | —                   | —                                                    | ✅ **done (pilot)**                                             |
| 1   | `RalphLoopResultView`         | `ralph-loop`          | step                | stretch / 3xl   | yes          | no                | no                | status badge        | `ralph-loop-window`                                  | ✅ done                                                         |
| 2   | `GenericStructuredResultView` | `generic-structured`  | step                | stretch / 4xl   | yes          | no                | no                | —                   | —                                                    | ✅ done                                                         |
| 3   | `TestReportWindow`            | `tester`              | step                | stretch / 5xl   | yes          | no                | no                | greenlight + fix ct | `tester-report-window`                               | ✅ done (lightbox reconciled onto the shared stack — see below) |
| 4   | `GateResultView`              | `gate`                | step                | stretch / 3xl   | yes          | no                | no                | status badge        | —                                                    | ✅ done (`gate-status` testid added for the shell e2e)          |
| 5   | `FollowUpWindow`              | `follow-ups`          | step                | stretch / 3xl   | no           | no                | no                | pending-count badge | —                                                    | ✅ done                                                         |
| 6   | `HumanTestWindow`             | `human-test`          | step                | stretch / 3xl   | no           | no                | no                | —                   | —                                                    | ✅ done                                                         |
| 7   | `VisualConfirmationWindow`    | `visual-confirm`      | step                | stretch / 5xl   | no           | no                | no                | —                   | —                                                    | ✅ done (lightbox reconciled onto the shared stack — see below) |
| 8   | `ForkDecisionWindow`          | `fork-decision`       | step                | stretch / 3xl   | no (pre-run) | yes (load)        | —                 | —                   | `fork-decision-window` (was on backdrop → now shell) | ✅ done                                                         |
| 9   | `PrReviewWindow`              | `pr-review`           | step/instanceId     | stretch / 3xl   | no           | yes (load)        | —                 | "Open PR" link      | `pr-review-window` (backdrop → shell dialog)         | ✅ done                                                         |
| 10  | `ClarityReviewWindow`         | `clarity-review`      | block               | centered / 5xl  | no           | yes               | yes (flush)       | iteration badge     | —                                                    | ✅ done                                                         |
| 11  | `BrainstormWindow`            | `brainstorm`          | block + stage       | centered / 5xl  | no           | yes               | no                | iteration badge     | —                                                    | ✅ done (stage-varied icon/title/subtitle)                      |
| 12  | `RequirementsReviewWindow`    | `requirements-review` | step; data by block | centered / 5xl  | yes          | yes (reset+load)  | yes (flush)       | iteration badge     | —                                                    | ✅ done (biggest; `stepRef` + `onClose`)                        |
| 13  | `InitiativeTrackerWindow`     | `initiative-tracker`  | block               | stretch / 4xl   | no           | yes               | —                 | progress + status   | `initiative-tracker-window`                          | ✅ done                                                         |
| 14  | `InitiativePlanningWindow`    | `initiative-planning` | block               | stretch / 3xl   | no           | yes               | —                 | status badge        | `initiative-planning-window`                         | ✅ done                                                         |
| 15  | `ServiceSpecWindow`           | `service-spec`        | block (frame)       | centered / 5xl  | no           | yes               | —                 | view toggle         | —                                                    | ✅ done                                                         |
| 16  | `ConsensusSessionWindow`      | `consensus-session`   | block               | centered / 5xl  | no           | yes               | —                 | status badge        | —                                                    | ✅ done (composed title + subtitle)                             |
| 17  | `DocInterviewWindow`          | `doc-interview`       | block               | stretch / 3xl   | no           | yes               | —                 | status badge        | `doc-interview-window`                               | ✅ done (final window)                                          |

_(Confirm each window's exact `variant`/`width`/`icon`/extras against its current template
when converting — the table is the survey's read, not a substitute for the diff.)_

## Conversion batch outcomes (windows 1–8)

Windows 1–8 landed together behind the pilot's `ResultWindowShell`, each as body-only markup
wrapped in the shell with `useResultView(..., { manageEscape: false })`. What the survey's
per-window row got right, and what bent against the actual template:

- **The nested lightbox is reconciled onto the shared overlay stack, not guarded off.** The two
  windows with a screenshot lightbox (`TestReportWindow`, `VisualConfirmationWindow`) used to run
  their OWN `useFocusTrap` gated `active: open && !lightboxOpen` so the two Tab traps never fought,
  and the lightbox owned Escape via a capture-phase `stopPropagation`. With the shell owning the
  window's trap via `useModalBehavior` (active whenever the window is open, it can't know about the
  lightbox), that guard has nowhere to live. The fix is the one the parent tracker's gotcha called
  for: **`ArtifactLightbox` now uses `useModalBehavior` itself**, so it PUSHES onto the shared stack
  while open and becomes the top overlay. `useModalBehavior` gates BOTH its Escape and its Tab-trap
  on `isTop()` (verified in the released `@modular-vue/vue@1.4.1` build), so the window's trap goes
  inert while the lightbox is up and the stack orders Escape (lightbox first) — no fight, no
  double-close, no bespoke `stopPropagation`. The lightbox keeps only its own arrow/zoom keys,
  now `isTop`-gated too. This fixed BOTH windows at the shared component, and it deleted the local
  `useFocusTrap` composable (its only three callers — the two windows + the lightbox — are gone).
- **`useFocusTrap` is deleted.** With the lightbox on `useModalBehavior` and the windows on the
  shell, nothing imported it; leaving it would fail `knip` as an unused auto-import. Removed in the
  same change per "prefer deleting to accreting."
- **Header extras are the `#header-extras` slot, verbatim from each template.** `RalphLoopResultView`
  (status badge — the survey row said "—"; the template has one), `GateResultView` (status badge),
  `FollowUpWindow` (pending-count badge), and `TestReportWindow` (greenlight badge + fix-count span)
  keep their window-specific header content in the slot; the shell owns only the standard row.
- **`ForkDecisionWindow`: no `stepRef`, and its testid moved from backdrop to the shell dialog.** The
  survey row read "stepRef yes-load", but the actual template has NO `StepRestartControl` (it is a
  PRE-RUN decision — nothing to "restart from here"), so `stepRef` is omitted to preserve behaviour;
  it keeps its `onOpen` loader. Its `fork-decision-window` testid was on the backdrop `<div>`; passing
  it as the shell's `testid` puts it on the dialog panel, which is still an ancestor of every
  `fork-option-card` / `fork-chat-*` the `fork-decision.spec` selects through it, so the e2e is
  unaffected.
- **Selection + registry unchanged.** No `StepResultViewHost` / `result-views.ts` edits — the shell is
  per-window chrome, exactly as the pilot established. `GateResultView` gained one behaviour-neutral
  `data-testid="gate-status"` (mirroring `ralph-status`) so the new shell e2e can assert the
  header-extras slot renders for a non-pilot window.

## Conversion batch outcomes (windows 9–17 — the block-keyed + review windows)

The remaining nine windows landed together, completing all 18. They are dominated by
**block-keyed** windows (the review loops, the initiative/spec/consensus/doc surfaces) rather
than the step-keyed windows of batch 1–8, so `stepRef` is omitted on all but one — a block-keyed
window has no "restart from here" step to surface (the pilot pattern's rule). What the survey
row got right, and what bent against the actual template:

- **`stepRef` only on `RequirementsReviewWindow`.** The survey's per-window row read "stepRef
  yes" for windows 12–17, but only the requirements window actually renders a `StepRestartControl`
  (it destructures `instanceId`/`stepIndex` and is a genuine step-result gate) — so it is the only
  one passed `:step-ref`. The initiative/spec/consensus/doc/clarity/brainstorm windows are
  block-keyed (they never read a step), so adding a restart control would be NEW behaviour; `stepRef`
  is omitted to preserve them, exactly as `ForkDecisionWindow` was in batch 1–8. `PrReviewWindow` is
  step-keyed but has no restart control either (an `awaiting_selection` park, nothing to restart),
  so it too omits `stepRef` and keeps only its `onOpen` loader.
- **Header variance lives in `#header-extras`, verbatim.** Each window's window-specific header
  content moved into the slot untouched: the iteration badge (clarity / brainstorm / requirements),
  the status badge (initiative-planning / consensus / doc-interview), the progress bar + status pair
  (initiative-tracker), the "Open PR" link (pr-review), and the structured/Gherkin **view toggle**
  (service-spec). The shell owns only the standard icon/title/subtitle/restart/close row.
- **Composed titles where the header wasn't a single string.** `ConsensusSessionWindow`'s header was
  a structured `h2` ("Consensus · <strategy> — <block>") plus a subtitle line; it became two computed
  strings (`headerTitle`/`headerSubtitle`) feeding the shell's plain `title`/`subtitle` props — the
  one place a lighter inline `<span>` for the block name is dropped for the shell's uniform truncation
  (a deliberate, negligible chrome change). The other windows mapped cleanly: title = the window
  title, subtitle = the block title (or the stage-varied title for brainstorm).
- **`onClose` flush preserved on the auto-saving review windows.** `Clarity` and `Requirements`
  auto-save answers on blur and flush any un-blurred draft on close; that `onClose` seam is kept
  as-is. `Brainstorm` has an explicit "save" button (no blur-save), so it has no `onClose` — not
  added (the survey row's "onClose yes" was wrong for it).
- **Three converted windows dropped their `IconButton` close** (clarity / brainstorm / requirements /
  service-spec used `IconButton` for the close affordance; the shell owns close), and requirements
  additionally dropped its header `StepRestartControl` import (now shell-rendered via `stepRef`). No
  window kept a stray import.
- **Selection + registry unchanged**, as every batch before: no `StepResultViewHost` / `result-views.ts`
  edits — the shell is per-window chrome.

## Final cleanup (done — the slice closes on it)

With the last window on the shell, the deferred cleanup landed in the same change:

- **`useResultView`'s Escape branch is deleted, and the `manageEscape` option with it.** Every one
  of the 18 windows now renders through `ResultWindowShell`, whose `useModalBehavior` owns Escape via
  the shared overlay stack. `useResultView` no longer registers a global `keydown` listener (the
  `onMounted`/`onBeforeUnmount` pair and `onKey` are gone), and its options type drops `manageEscape`.
  Every caller that was passing `manageEscape: false` (all 18) had it removed — the single-option
  callers collapse to a bare `useResultView('<id>')`. This is the "drop the Escape branch once every
  window is on the shell" item from the refinements list, now complete.
- **e2e:** the `initiative-checkpoint` spec (which already opens the block-keyed
  `initiative-tracker-window`) gained shell assertions on its first test — the `#header-extras`
  progress chip renders, and Escape closes the window then it reopens — proving the shell-owned Escape
  keeps working for a block-keyed window after `useResultView`'s listener was removed. The existing
  three `result-window-shell` specs continue to cover the step-keyed close mechanics (button / backdrop
  / Escape), the header-extras slot, and the nested lightbox.

## Planned refinements (tracked, not yet done)

- **Promote the shared header controls to a step-keyed panel group** (the slice-4 panels
  reuse the parent spec calls for): `StepRestartControl` (and any future cross-window
  header control) becomes a `resultWindowHeader` `definePanelGroup<StepRef>` rendered by the
  shell via `<PanelsOutlet :subject="stepRef">`, so a **consumer** can contribute a header
  control keyed by the step — the extensibility half. Deferred out of the pilot to keep the
  first window a focused chrome+behaviour reference; the shell renders `StepRestartControl`
  directly (prop-gated) until then. Needs the slot + registry + client-plugin wiring +
  boot-resolve, mirroring `inspector.logic.ts`/`inspector.ts`.
- **The two full-bleed panels** `AgentStepDetail` + `ObservabilityPanel` are driven by
  separate `ui` state (`stepDetail` / `observabilityInstanceId`), are `<Transition>`-wrapped
  and full-bleed (no card/backdrop-click), so they do NOT fit the centered-card shell. They
  adopt the behaviour via `useModalBehavior` directly (the bespoke-root path) for consistent
  focus/escape/scroll — a separate, later item, not one of the 18.
- ~~**Final cleanup:** once every window is on the shell, drop the Escape branch from
  `useResultView` entirely (the `manageEscape` option goes with it) — the shell owns it.~~
  **Done** (see "Final cleanup" above): the Escape branch + the `manageEscape` option are gone.

## Conventions & gotchas

- **`manageEscape: false` is mandatory on every converted window** — forgetting it
  double-fires `close` on Escape (the shell's stack listener + `useResultView`'s). It stays
  the opt-out until the last window converts and the listener is removed wholesale.
- **The window unmounts on close** (`StepResultViewHost`'s `v-if`), so `useModalBehavior`'s
  focus-return + scroll-unlock + stack-release fire via `active → false` and unmount — no
  manual teardown in a window.
- **Windows with their own `useFocusTrap` + a nested lightbox** (`TestReportWindow`,
  `VisualConfirmationWindow`) must drop the local trap (the shell owns it) and reconcile the
  lightbox with the shared stack (the lightbox is the top overlay while open — let the stack
  order Escape) rather than the old `active: open && !lightboxOpen` guard.
- **Header variance stays in the window, not the shell** — window-specific badges go in the
  `#header-extras` slot; the shell owns only the standard row (icon/title/subtitle/restart/
  close). This is why the shell is a slotted component the window renders, NOT the upstream
  headless `OverlayOutlet` (which renders the window as opaque `children` and would force
  each window's dynamic title/badges through entry metadata). `useModalBehavior` is the
  sanctioned upstream API for exactly this bespoke-root case.
- **e2e-first** per `CLAUDE.md`: a live-push spec on the result-window open/close (+ a
  step-keyed live update) lands with the conversions; assert on the shell's stable testids.
- **Changeset:** the slice needs a `@cat-factory/app` changeset (the shared shell + the
  `useResultView` seam change are consumer-visible).

## Key files

- `app/components/panels/ResultWindowShell.vue` — the shell (chrome + `useModalBehavior`).
- `app/composables/useResultView.ts` — the Escape branch + `manageEscape` option **removed** in the
  final batch (every window is on the shell, so the shell owns Escape; a listener here would double-fire).
- `app/components/panels/MergerResultView.vue` — the pilot conversion (reference).
- `app/modular/result-views.ts` — the (unchanged) slice-2 `resultViews` registry the host
  still selects from; windows stay registered here.
- Converted windows (batch 1–8): `app/components/ralph/RalphLoopResultView.vue`,
  `app/components/panels/GenericStructuredResultView.vue`,
  `app/components/testing/TestReportWindow.vue`, `app/components/gates/GateResultView.vue`,
  `app/components/followUp/FollowUpWindow.vue`, `app/components/humanTest/HumanTestWindow.vue`,
  `app/components/visualConfirm/VisualConfirmationWindow.vue`,
  `app/components/forkDecision/ForkDecisionWindow.vue`.
- Converted windows (batch 9–17, the last batch): `app/components/prReview/PrReviewWindow.vue`,
  `app/components/clarity/ClarityReviewWindow.vue`, `app/components/brainstorm/BrainstormWindow.vue`,
  `app/components/requirements/RequirementsReviewWindow.vue`,
  `app/components/initiative/{InitiativeTrackerWindow,InitiativePlanningWindow}.vue`,
  `app/components/spec/ServiceSpecWindow.vue`, `app/components/consensus/ConsensusSessionWindow.vue`,
  `app/components/docs/DocInterviewWindow.vue`.
- `backend/internal/e2e/tests/initiative-checkpoint.spec.ts` — the block-keyed
  `initiative-tracker-window` shell coverage (header-extras render + Escape close + reopen), added
  to the existing checkpoint flow at no extra setup cost.
- `app/components/media/ArtifactLightbox.vue` — reconciled onto the shared overlay stack via
  `useModalBehavior` (was local `useFocusTrap`), so it layers above an owning window.
- `app/composables/useFocusTrap.ts` — **deleted** (no remaining callers).
- `backend/internal/e2e/tests/result-window-shell.spec.ts` — the shell e2e; a second test now
  covers the CI `gate` window (header-extras + Escape handoff), and a third covers the
  **nested-lightbox reconciliation** on the tester window: open `ArtifactLightbox` from a
  screenshot thumbnail, then assert stacked-Escape ordering (lightbox closes first, the owning
  window survives, a second Escape closes the re-topped window). Behaviour-neutral testids added
  for it: `artifact-lightbox` (lightbox root) + `tester-screenshot` (thumbnail button).
