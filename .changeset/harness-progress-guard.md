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
bound is skipped for assess-only runs (`expectsEdits: false`) so a run that correctly
makes zero edits is never falsely aborted — this covers both the merger AND the
Blueprinter, which explores the repo and returns the service tree as JSON (the harness
renders the files), so it never calls an edit tool itself. The edit-tool detection
also recognises alternate names case-insensitively (`apply_patch`/`str_replace`/
`multiedit`/… in addition to `edit`/`write`) so a model that mutates files under a
different tool name is not mistaken for one making no edits. The no-edit bound counts
only "action" calls (chiefly `bash`, the rabbit-hole's vector): read-only exploration
(`read`/`grep`/`glob`/…) and planning (`todo`) are excluded, so a large task that
legitimately reads or searches many files before its first edit is not killed for it
(the default ceiling is correspondingly generous).
