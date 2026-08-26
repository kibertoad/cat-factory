---
'@cat-factory/executor-harness': minor
'@cat-factory/orchestration': patch
---

Decide the no-progress bound on the working tree, and stop discarding an aborted run's work.

`ProgressGuard`'s no-edit bound judged whether a run was making progress by looking at TOOL NAMES,
so an agent writing every file through `bash` (heredocs, `sed -i`, `node -e`) read as "40 tool
calls and not one file edit" however much it had built, and the guard killed it. It now returns a
discriminated verdict: the four streak bounds stay immediate, while the no-edit bound is
provisional and settled by a working-tree probe (`git status --porcelain --untracked-files=all`
plus whether `HEAD` moved off the sha the pass began at). The probe is injected, runs at most once
per run and only at the instant the bound is about to abort, and a probe that THROWS is
inconclusive: the bound re-arms and warns rather than killing a run on a transient git failure.

When a run is aborted, the new files the agent created and never committed are now salvaged onto
the work branch and pushed instead of being logged and dropped with the container. On a greenfield
task every file is new, so that log line was the whole deliverable going in the bin. The salvage
carries a dependency/build deny-list (a checkout whose agent had not written a `.gitignore` yet
would otherwise swallow `node_modules`) and file-count plus byte bounds that refuse the whole
salvage rather than truncating it, since a half-committed tree reads as a complete change. The
commit message states that it came from an aborted run and that nothing reviewed it, and the same
recovery now runs on the ordinary settle path, where a forgotten new file was silently dropped
from the pull request.

The generic `agent` failure hint no longer claims the step "failed after its automatic retries",
which it cannot know and which was wrong on the run that prompted this: it points at the step's own
attempt count and failure detail instead.
