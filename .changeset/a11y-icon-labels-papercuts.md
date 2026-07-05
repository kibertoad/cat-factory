---
'@cat-factory/app': patch
---

UX papercuts — accessibility: icon-button labeling, keyboard, focus & reduced motion (section F, UX-62..UX-66)

- **UX-62/63 (P1/P2): icon-only buttons are named by construction.** New shared
  `common/IconButton.vue` primitive (mirroring `common/CopyButton.vue`) requires a `label`
  and applies it as BOTH `title` (pointer tooltip) and `aria-label` (screen readers),
  forwarding all other UButton props/listeners via `$attrs`. Every previously-unlabeled
  dismiss button now routes through it with `t('common.close')`: the block focus view,
  clarity / brainstorm / requirements review windows, the inspector, and the service-spec
  window. This replaces the ad-hoc mix of title-only / aria-only / nothing with one
  enforceable convention.
- **UX-64 (P2): the task card's mini pipeline steps are keyboard-operable.** The clickable
  `<div>` is now a real `<button type="button">` — focusable, Enter/Space-activatable, with
  a `focus-visible` ring — instead of a pointer-only, screen-reader-invisible target.
- **UX-65 (P2): hand-rolled inputs have a visible focus ring.** The textareas that only
  swapped their border hue on focus (human-test, follow-up, gate human-review, both
  visual-confirmation notes) now add `focus-visible:ring-2` (fixing the WCAG 2.4.7
  hue-only-focus failure).
- **UX-66 (P2): decorative animations respect `prefers-reduced-motion`.** A
  `@media (prefers-reduced-motion: reduce)` block silences the infinite attention pulses
  (blocked / decision-needed halo, PR-ready halo, the active-step and follow-up halos) and
  the marching-ants edge animation. Loading spinners are intentionally left animating — a
  spinner's motion is its meaning.
