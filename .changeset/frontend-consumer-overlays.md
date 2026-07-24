---
'@cat-factory/app': minor
---

Consumer extension mechanism, slice D: top-level overlays. A deployment extending the
`@cat-factory/app` layer can now contribute its own full-screen overlays through the new
`appOverlays` slot (`{ id: '<ns>:<name>', component }`) and open them from anywhere — typically a
nav item's `run` closure — via the auto-imported `useAppOverlays().open(id, subject?)` composable
(or `ui.openOverlay`). A single `<AppOverlayHost>` mounted in the layer resolves the slot with the
same `resolveComponentRegistry` pick-one primitive the result-view host uses, mounts the matching
component, and hands it the optional `subject` prop + a `close` emit; the overlay composes the
shared `ResultWindowShell` for chrome so it inherits focus-trap / scroll-lock / shared-stack
Escape. This is the one host surface a consumer could not extend before (a nav `run` closure had
nothing to open). Duplicate ids fail fast at boot; a dangling open degrades to nothing with a
dev-warn. First-party modals stay hand-mounted (strangler-scoped to consumer overlays). Built
entirely on already-landed modular-vue primitives — no upstream release required.
