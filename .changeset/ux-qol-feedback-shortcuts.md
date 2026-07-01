---
"@cat-factory/app": patch
---

UX quality-of-life pass (part 2): confirm silent actions with feedback toasts (run
started, notification handled/dismissed, one-click-copyable container id/url) and add a
global keyboard layer — Escape to deselect/close the inspector, Delete/Backspace to remove
the selected block (through the same confirm-gated deletion the inspector button uses), and
`?` for a keyboard-shortcuts cheatsheet (also reachable from the command bar). Delete is
guarded so it never fires while typing, and Escape yields to any open modal.
