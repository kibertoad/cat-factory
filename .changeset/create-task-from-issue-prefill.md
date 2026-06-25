---
'@cat-factory/app': minor
---

Selecting an issue now opens the prefilled task form instead of creating the task immediately.

In the "Create task from issue" modal, clicking an issue row selects it as the task source:
it opens the add-task form with the title prefilled and the issue staged as linked context,
so the user still confirms the pipeline and presets before the task is created. The issue
itself is only linked (its body is not copied into the description). Viewing the issue on
GitHub moved to a dedicated external-link button on each row, and long issue titles now
truncate instead of overflowing under the status badge.
