---
"@cat-factory/app": patch
---

Fix crash when opening "Add from selected repo" on the board: the open-watch ran
its `immediate` callback (`resetSelection()`) during setup before the selection
refs were initialized, throwing `Cannot access 'selectedDirectory' before
initialization`. The watch is now declared after the refs it touches.
