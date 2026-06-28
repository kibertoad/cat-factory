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
- New `useFocusTrap` composable — both review windows and the lightbox now move focus inside
  on open, trap Tab, and restore focus on close (the window hands the trap off to the lightbox
  while it's open, so nested surfaces don't fight over Tab).
- Comparator robustness: overlay/swipe fit the actual within the reference box
  (`object-contain`) so a differing aspect ratio no longer stretches it; the diff render
  guards against stale async draws; drag-dropped references are restricted to the same
  PNG/JPEG the picker accepts; the "upload a reference for any view" picker now requires a
  view name (an empty one can't pair and was silently orphaned); and the blob cache revokes a
  fetch that resolves after the window unmounts instead of leaking it.

Frontend-only; no backend/contract changes (the per-view findings compose into the existing
`findings` string).
