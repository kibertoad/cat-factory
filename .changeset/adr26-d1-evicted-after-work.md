---
'@cat-factory/orchestration': patch
---

Report a container lost to an eviction after work had begun as `evicted`, not "container failed to start" (ADR 0026 D1). `classifyDispatchFailure` now takes the step's run history (eviction-recovery count, start time, partial slice count); a failed recovery re-dispatch of a step that already reached the agent phase is framed as "The container was evicted after N minutes of work … and could not be recovered" with `failureKind: 'evicted'`, instead of the misleading fresh-start message.
