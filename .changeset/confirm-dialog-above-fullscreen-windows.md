---
'@cat-factory/app': patch
---

Fix the shared confirm dialog opening invisibly behind full-screen windows: `UModal` carries no
z-index of its own, so a destructive-action confirm triggered from inside a full-screen `z-50`
window (Model Configuration, Human Test) painted underneath the near-opaque overlay — clicking
"delete" on a model preset appeared to do nothing (the UI froze until Escape silently cancelled
the hidden dialog). The app-wide `ConfirmDialog` now stacks its overlay + content at `z-[70]`,
above the windows (`z-50`) and their dropdowns (`z-[60]`).
