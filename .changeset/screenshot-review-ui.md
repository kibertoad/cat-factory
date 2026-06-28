---
'@cat-factory/app': minor
---

Flesh out the tester-generated screenshot review UI — more robust, convenient, and
powerful, with the common review actions made pleasant.

- New reusable `ArtifactLightbox.vue` — a full-screen zoom/pan viewer over a SET of stored
  screenshots, with keyboard nav (Esc/←/→/+/-/0), wheel + double-click zoom, pointer pan,
  and per-image loading/error/retry states.
- New reusable `ImageCompare.vue` — actual-vs-reference comparator with four modes:
  side-by-side, overlay (onion-skin opacity slider), swipe (draggable split), and a
  client-side canvas pixel-difference (degrades to overlay if the canvas is ever tainted).
- New `useArtifactBlobs` composable — extracts the authed artifact-blob → object-URL
  caching (with in-flight dedupe + status tracking) out of the visual-confirm store so both
  review windows own and revoke their own blob cache on unmount.
- `VisualConfirmationWindow` reworked to use the comparator + lightbox, drag-and-drop a
  reference straight onto a pair (view pre-filled) or pick by view via a datalist, and
  attach per-view findings that are composed into the Fixer's findings alongside a freeform
  box.
- `TestReportWindow` now renders the UI tester's captured screenshots (previously hidden):
  thumbnails mapped under the matching scenario, an "ungrouped" gallery for the rest, and
  click-to-zoom via the shared lightbox.

Frontend-only; no backend/contract changes (the per-view findings compose into the existing
`findings` string).
