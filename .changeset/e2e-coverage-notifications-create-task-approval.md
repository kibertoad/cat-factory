---
'@cat-factory/app': patch
---

Add `data-testid` test hooks to more board surfaces so the `@cat-factory/e2e` Playwright
suite can target stable selectors: the notifications inbox (bell, item + `data-notification-type`,
act/dismiss), the add-task modal (modal, title, submit) + the frame "Add task" button, and the
agent step-detail approval rail (overlay + "Approve & proceed"). Additive only — inert attributes,
no behaviour change.
