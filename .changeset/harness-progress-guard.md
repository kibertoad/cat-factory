---
'@cat-factory/executor-harness': patch
---

Add a live no-progress guard to the container coding agent so a run that has plainly
stopped making progress is killed early with a useful diagnostic, instead of burning
the whole budget and failing with a generic "no file changes".

`runPi` now feeds every streamed Pi event to a `ProgressGuard` that aborts when the
agent makes many tool calls without ever editing a file (the signature of the
credential rabbit-hole: exploring/probing the environment without implementing) or
makes too many consecutive failing tool calls. Bounds are env-configurable
(`JOB_MAX_TOOLCALLS_WITHOUT_EDIT`, `JOB_MAX_CONSECUTIVE_TOOL_ERRORS`); the no-edit
bound is skipped for assess-only runs (`expectsEdits: false`, used by the merger) so
a run that correctly makes zero edits is never falsely aborted.
