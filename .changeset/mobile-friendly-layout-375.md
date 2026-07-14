---
'@cat-factory/app': patch
---

Mobile-friendly layout fixes at 375px (initiative slice B): stop the desktop-first layouts
that clip, collapse, or hide their content on a phone.

Fulfils goal #1 of the mobile-friendly frontend initiative — "nothing broken at 375px" — by
restacking the fixed-column layouts that had no breakpoint. Every change follows an existing
good-citizen pattern (P-1 restack / P-6 reflow); no new responsive system is introduced.

- **BlockFocusView (B1).** The full-screen focus overlay used a hard `grid-cols-[1fr_300px]`
  with no breakpoint, so at 375px the main pipeline column collapsed toward zero width. It now
  restacks to a single scrolling column below `lg` (`grid-cols-1 … lg:grid-cols-[1fr_300px]`,
  with the container scrolling vertically on mobile and clamping to the docked two-column form
  on wide screens).

- **Non-collapsing `grid-cols-2` forms (B2).** Budget, workspace task-limit, risk-policy, and
  bootstrap-architecture forms hard-coded `grid-cols-2`, cramming two number inputs side by
  side at 375px. They now start single-column and opt into columns at a breakpoint
  (`grid-cols-1 sm:grid-cols-2`); the risk-policy 4-up grids collapse fully on phones while
  keeping their density on wide (`grid-cols-1 sm:grid-cols-2 lg:grid-cols-4`).

- **Kaizen table (B3).** The grading-history table was wrapped in `overflow-hidden`, clipping
  columns on narrow screens; it now uses `overflow-x-auto` like every other table so it scrolls
  horizontally instead.

- **Side rails that hid instead of restacking (B4).** The Brainstorm window's action rail —
  which carries the primary proceed / incorporate / re-run controls — and the Test-report
  window's metadata rail were `hidden lg:flex`, making those actions and the outcome summary
  unreachable on a phone. Both now restack as a full-width section below the main column below
  `lg` (copying the `RequirementsReviewWindow` reference: informational stats collapse, the
  actions stay reachable). The `AgentStepDetail` table-of-contents rail was verified redundant
  on mobile (a jump-nav duplicating headings already in the scrollable prose), so it stays
  hidden below `lg` — only its stray `md:` breakpoint is normalized to the `lg` cutoff.

No user-facing copy added, so no i18n/locale changes.
