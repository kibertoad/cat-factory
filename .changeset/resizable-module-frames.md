---
'@cat-factory/app': patch
---

Make module boundaries inside a service resizable, Miro-style, exactly like
service frames. A module frame can now be resized by dragging its right / bottom
edges or the bottom-right corner; `ModuleFrame.vue` reuses the existing
`useFrameResize` composable, so the drag is zoom-aware, clamped to the module's
content extent (never shrunk below its tasks) and persisted once on release via
the existing `PATCH /blocks/:id` `size` field. No backend or contract changes:
`Block.size` and its `width`/`height` persistence already cover any block.
