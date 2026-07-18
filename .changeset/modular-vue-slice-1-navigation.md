---
'@cat-factory/app': minor
---

Adopt modular-vue in the Nuxt layer (slice 1: navigation manifest). The
`SideBar`, `CommandBar`, and `BoardToolbar` shells now render from a single
nav/command catalog (`app/modular/nav-contributions.ts`) instead of each
hand-maintaining its own item list + RBAC gating. Gating is a reactive
`slotFilter` over a `gates` service, read through `@modular-vue`'s new
`useReactiveSlots`, so an item shows/hides the instant a permission or connection
flips (no manual invalidation). A consumer deployment contributes its own
destinations to the same `nav` slot via `registerAppModule`, and they render in
all three shells (`sidebar` / `command` / `toolbar` surfaces) with no shell
edits. The dynamic per-connection integration commands (GitHub/Slack/document/
task connect) stay local to the command palette. Behaviour is preserved except
two intentional consistency fixes: account settings gates on `accountsEnabled` in
both the sidebar and the palette, and each destination uses one icon across
shells.
