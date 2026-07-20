---
'@cat-factory/orchestration': minor
'@cat-factory/app': minor
'@cat-factory/contracts': patch
---

Make a task's best-practice fragment selection authoritative. A new task is now seeded from
its enclosing service's `serviceFragmentIds` at creation (the create-form picker is pre-filled
with them, and a task created without the form — e.g. via the public API — inherits them too),
and the engine folds exactly the task's own `fragmentIds` at run time instead of re-unioning the
service's set. This is what lets a task genuinely add OR remove a best-practice fragment for
itself: removing an inherited one on the create form (an explicit empty selection is honoured, not
re-seeded) or in the inspector now actually drops it for that task's agents. A frame-level run
(e.g. `blueprints`) still folds in the service's own standards. Existing tasks are not
retroactively changed when a service's selection later changes — a new fragment is picked up by
adding it to the task by hand.
