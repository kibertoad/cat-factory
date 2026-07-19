---
'@cat-factory/app': minor
---

Adopt modular-vue slice 5 (agent-run window chrome → `ResultWindowShell`): convert
the next 8 result windows behind the shared shell, after the `MergerResultView`
pilot. `RalphLoopResultView`, `GenericStructuredResultView`, `TestReportWindow`,
`GateResultView`, `FollowUpWindow`, `HumanTestWindow`, `VisualConfirmationWindow`,
and `ForkDecisionWindow` are now body-only markup wrapped in `ResultWindowShell`,
each passing `useResultView(..., { manageEscape: false })` so the shell owns Escape
(via the upstream `useModalBehavior` shared overlay stack) instead of a per-window
listener. Window-specific header content (status / greenlight / pending-count
badges) moves to the shell's `#header-extras` slot; the pick-one selection stays the
slice-2 `resolveComponentRegistry` in `StepResultViewHost`, so no host or registry
changes.

The two windows with a nested screenshot lightbox (`TestReportWindow`,
`VisualConfirmationWindow`) are reconciled onto the SAME shared overlay stack:
`ArtifactLightbox` now uses `useModalBehavior` itself, so it pushes onto the stack
while open and becomes the top overlay — its Escape/Tab-trap win and the owning
window's trap goes inert (both gated on `isTop()`), replacing the old
`active: open && !lightboxOpen` guard and the lightbox's bespoke capture-phase
Escape. The now-unused `useFocusTrap` composable is deleted.

`GateResultView` gains a behaviour-neutral `data-testid="gate-status"` so the
result-window-shell e2e can assert the header-extras slot renders for a non-pilot
window. `ForkDecisionWindow`'s `fork-decision-window` testid moves from the backdrop
to the shell dialog (still an ancestor of the elements its e2e selects).
`ArtifactLightbox` (its root) and the tester report's screenshot thumbnail gain
behaviour-neutral `data-testid="artifact-lightbox"` / `data-testid="tester-screenshot"`
so the e2e can drive the nested-overlay reconciliation end-to-end.

`VisualConfirmationWindow`'s dedicated `visualConfirm.ariaLabel` message is removed
(from every locale): under the shell the dialog's accessible name is the visible
title, and that key duplicated `visualConfirm.title` verbatim, so it was orphaned.

Progress tracked in `docs/initiatives/modular-vue-slice5-progress.md`.
