---
'@cat-factory/app': patch
---

UX papercuts — the requirements & clarity review windows (UX-32/33/34)

- **UX-32 (P1): the review gate is no longer unadvanceable below `lg`.** The action rail
  (Proceed / Incorporate / Re-review / Redo / resolve-exceeded) used to live in an
  `aside` that was `hidden` below the `lg` breakpoint, so on a laptop split-screen or
  tablet the human could answer findings but had no visible way to advance the gate. The
  rail is now a right-hand column on wide screens and a bottom action bar below `lg`
  (never hidden); the purely-informational stats collapse away below `lg` to keep the bar
  compact.
- **UX-33 (P1): typed answers are no longer lost on close.** Closing a review window (X,
  backdrop, or Escape) now flushes any typed-but-unblurred answer before the view tears
  down. `useResultView` grew an `onClose` hook so all three close paths flush through one
  seam; the flush snapshots the review up front so it survives the reactive state going
  null on close.
- **UX-34 (P2): the two review windows now share one save model.** The clarity window
  auto-saves answers on blur (seeding each textarea from the recorded reply), matching the
  requirements window, instead of requiring an explicit "Save answer" click — so muscle
  memory from one no longer silently drops data in the other.
