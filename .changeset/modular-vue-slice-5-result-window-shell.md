---
'@cat-factory/app': minor
---

Adopt modular-vue in the Nuxt layer (slice 5: agent-run window chrome →
`ResultWindowShell`), pilot conversion. The upstream overlay-host primitive
shipped (`@modular-frontend/core@0.5.0`: `defineOverlayHost` / `resolveOverlay` /
`OverlayEntry` / `OverlayStack`; `@modular-vue/{core,vue}@1.4.x`: `OverlayOutlet` /
`useOverlay` / `useOverlaySubject` / `useModalBehavior`), and the ~18 result
windows that each hand-rolled the same modal chrome start converting behind one
shared shell.

`app/components/panels/ResultWindowShell.vue` centralises the chrome
(`<Teleport>` + backdrop + bordered card + header with icon/title/subtitle/
`#header-extras` slot/opt-in `StepRestartControl`/close) and delegates the modal
_behaviour_ to the upstream `useModalBehavior`: focus-trap + focus-return,
body-scroll lock, and a shared overlay stack so the top overlay closes first on
Escape — replacing the per-window duplication where only 2 of 18 windows trapped
focus and each registered its own global Escape listener. Windows convert one at a
time: the pick-one selection stays the slice-2 `resolveComponentRegistry` in
`StepResultViewHost`, so the shell needs no host or registry changes. The pilot is
`MergerResultView`; the remaining windows are tracked in
`docs/initiatives/modular-vue-slice5-progress.md`.

`useResultView` gains a `manageEscape` option (default `true`); a shell-hosted
window passes `false` so the shell owns Escape (a second listener would
double-fire `close`). The option is removed once every window is converted.

Deps: bumped `@modular-frontend/core` `^0.4.0 → ^0.5.0`, `@modular-vue/core` /
`@modular-vue/vue` `^1.3.0 → ^1.4.0` (for the overlay API), and the pnpm
`@modular-frontend/core` override `0.4.0 → 0.5.0` (0.5.0 is an additive superset;
still needed because `@modular-vue/journeys@1.3.0` pins
`@modular-frontend/journeys-engine@1.8.0`, which deps core `0.3.0`).
