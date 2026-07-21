---
'@cat-factory/prompt-fragments': minor
'@cat-factory/orchestration': patch
---

Add a programmatic seam to mark prompt fragments as the default for every new task of a
given type. A deployment (local or hosted) registers its own custom fragments via
`registerPromptFragments(...)` and then declares them as the per-type default via the new
`registerTaskTypeDefaultFragments(taskType, fragmentIds)` — so e.g. every new
documentation or review task starts with that org's guidance, with no per-block or
per-workspace configuration. The board seeds a new task's `fragmentIds` through
`defaultFragmentIdsForTaskType(taskType)`; the built-in document writing-style default is
now expressed through this seam and augmented (never replaced) by registered ids.
