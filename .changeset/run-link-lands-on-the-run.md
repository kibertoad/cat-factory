---
'@cat-factory/app': minor
---

The run deep link (`?ws=…&block=…&run=…`) lands on the run instead of only selecting its task: the
canvas switches from the queue if needed, the camera centres on the task's card at the zoom where a
task's pipeline steps render, and with no `view` (or `view=run`, new) the task's focus view opens on
its running pipeline. `view=outcome`, `observability` and `test-evidence` open those windows as
before, now with the task brought into view too. The queue's "Show on board" takes the same path,
so it zooms in on the task rather than only centring its service.
