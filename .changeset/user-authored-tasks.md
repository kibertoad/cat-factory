---
'@cat-factory/contracts': minor
'@cat-factory/orchestration': minor
'@cat-factory/kernel': minor
'@cat-factory/worker': patch
'@cat-factory/app': minor
---

Tasks are now authored by the user instead of being auto-generated. Removed the
random `TASK_NAME_BANK` placeholder titles: "Add task" opens a modal where the
user enters the task's title and description. A new task is created in `planned`
state and is never launched implicitly — the user starts a pipeline on it
explicitly, and can keep editing its title and description (in the inspector)
until it has started, after which those details are locked. `addTask` now
requires a `title` and accepts an optional `description`.
