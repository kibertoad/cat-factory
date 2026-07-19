---
'@cat-factory/app': minor
---

Adopt modular-vue in the Nuxt layer (slice 4: inspector panels → subject-keyed
panel group). The upstream subject-keyed **panels** primitive shipped
(`@modular-frontend/core@0.4.0`: `definePanelGroup` / `resolvePanels` /
`PanelEntry` / `PanelGroupHandle`; `@modular-vue/vue@1.3.0`: `PanelsOutlet` /
`usePanels` / `usePanelSubject`, re-exported from `@modular-vue/core@1.3.0`), and
`InspectorPanel.vue`'s level/type `v-if` fan is converted onto it.

The ~18 body sub-panels that used to be switched by `block.level`
(frame/module/task/epic/initiative) + `block.type` (frontend/service) are now
`PanelEntry<Block>` contributions to a first-party `inspectorPanels` group
(`app/modular/panels/inspector.{logic.,}ts`); `InspectorPanel.vue` renders them
through `<PanelsOutlet :group="inspectorPanels" :subject="block">`, which shows
every panel whose `when(block)` matches, ordered, with the selected block injected
as the subject. The pure gating/order lives in `inspector.logic.ts`
(unit-tested via `resolvePanels`); the SFC wiring is registered from the client
plugin (like the result-views and journey modules). A consumer deployment
contributes its OWN inspector panels to the same group via `registerAppModule`,
with zero host edits — the slice-4 extensibility promise.

The frame-only "view requirements" button and the cross-cutting run banners
(`AgentFailureCard` / `AgentStopButton`) stay in the host shell (not level-keyed
body panels). All existing sub-panel `data-testid`s are preserved.

Deps: bumped `@modular-frontend/core` `^0.2.0 → ^0.4.0`, `@modular-vue/core` /
`@modular-vue/vue` `→ ^1.3.0`, `@modular-vue/runtime` `→ ^1.4.0`, `@modular-vue/nuxt`
`→ ^0.4.0`, `@modular-vue/journeys` `→ ^1.3.0`, plus a `@modular-frontend/core: 0.4.0`
pnpm override so `@modular-frontend/journeys-engine` (which still deps `0.3.0`)
can't drag a second copy of the neutral core into the tree.
