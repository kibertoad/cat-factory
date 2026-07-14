---
'@cat-factory/app': patch
---

Mobile-friendly foundations (initiative slice A): safe areas, input font floor, theme color.

Implements the fix-once primitives of the mobile-friendly frontend initiative so the SPA
behaves on phones without a per-surface fight later:

- **Safe areas (A1).** The viewport meta now carries `viewport-fit=cover`, which is what
  makes `env(safe-area-inset-*)` resolve to non-zero on notched/rounded phones. Paired with
  it, the bottom-anchored fixed surfaces get `env(safe-area-inset-bottom)` clearance so their
  lowest controls clear the home indicator: the inspector and step-detail bottom sheets and
  the off-canvas sidebar drawer gain it as padding, while the toast viewport gets it added to
  its `bottom` offset (padding cannot lift a toast — each is `position: absolute; bottom: 0`
  inside the viewport, so it tracks the padding-box edge; the offset is the correct seam). The
  insets are 0 on desktop, so all of this collapses to the stock spacing there (no `lg:`
  override needed). The inspector and step-detail sheets also gain `overscroll-contain` so a
  scroll-to-end doesn't chain to the board behind them.

- **Input font floor (A2/A3).** iOS Safari auto-zooms the viewport whenever a focused field
  renders below 16px, jerking the layout on every tap into an input. A single fix-once CSS
  rule (`@media (pointer: coarse)` → `input`/`textarea`/`select` `font-size: max(16px, 1em)`)
  floors every editable control at 16px on touch devices while leaving desktop typography
  dense. This reaches Nuxt UI's rendered fields _and_ every hand-rolled raw one, and — unlike
  a component-default — cannot be defeated by a per-instance `size="sm"`. `max(16px, 1em)`
  floors without shrinking a deliberately larger field.

- **Theme color (A5, partial).** A `theme-color` meta tints the mobile browser chrome / iOS
  Safari address bar to the board surface (`#0b1020`) instead of a mismatched white bar. The
  home-screen/touch-icon + manifest work is folded into the initiative's deferred
  installability item (E2).

No user-facing copy added, so no i18n/locale changes. The shared `<ResultWindow>` overlay
extraction (A4) is the next slice.
