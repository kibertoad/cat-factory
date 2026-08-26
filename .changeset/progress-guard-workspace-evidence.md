---
'@cat-factory/executor-harness': minor
'@cat-factory/orchestration': patch
---

Decide the no-progress bound on the working tree, and stop discarding an aborted run's work.

`ProgressGuard`'s no-edit bound judged whether a run was making progress by looking at TOOL NAMES,
so an agent writing every file through `bash` (heredocs, `sed -i`, `node -e`) read as "40 tool
calls and not one file edit" however much it had built, and the guard killed it. It now returns a
discriminated verdict: the four streak bounds stay immediate, while the no-edit bound is
provisional and settled by a working-tree probe (`git status --porcelain -z --untracked-files=all`
plus whether `HEAD` moved off the sha the pass began at). The probe is injected, runs at most once
per run and only at the instant the bound is about to abort, and a probe that THROWS is
inconclusive: the bound re-arms and warns rather than killing a run on a transient git failure. A
multi-repo run works at a workspace root that is no repository, so it names its writable checkouts
and the probe answers over all of them: one changed repository is progress, but a checkout that
could not be probed makes the answer inconclusive rather than clean.

When a run is aborted, the new files the agent created and never committed are now salvaged onto
the work branch and pushed instead of being logged and dropped with the container. On a greenfield
task every file is new, so that log line was the whole deliverable going in the bin. The salvage
carries a dependency/build deny-list (a checkout whose agent had not written a `.gitignore` yet
would otherwise swallow `node_modules`) and file-count plus byte bounds that refuse the whole
salvage rather than truncating it, since a half-committed tree reads as a complete change. On that
same un-gitignored greenfield checkout the harness is also the only thing between an agent-authored
`.env` or private key and the pull request, so credential-bearing names are withheld and, unlike a
dependency tree, NAMED on the run's outcome: the file did not land, and anything real it held needs
rotating. The commit message states that it came from an aborted run and that nothing reviewed it,
and the same recovery now runs on the ordinary settle path, where a forgotten new file was silently
dropped from the pull request. In a multi-repo run, a leg whose branch is nothing BUT a salvage
opens its pull request behind a banner saying so.

Two things had to be right for any of that to happen on an aborted run, and are. The rescue runs on
a fresh, timeout-bounded signal rather than the run's: `execFile` rejects on an already-aborted
signal before it spawns, so a rescue carrying the watchdog's signal could not run one git command,
in exactly the watchdog and eviction cases it exists for. And it stops the checkpoint interval and
drains any push already in flight first, because the push coalesces and would otherwise report a
commit the remote never received; a push that fails now says the commit is lost with the container
rather than naming a sha nobody can fetch.

Every git path listing (`ls-files`, `status --porcelain`) is read with `-z`, and the salvage stages
each path as a `:(literal)` pathspec. Git's default output C-quotes a path holding a non-ASCII byte,
a quote or a newline, and everything after `--` is a pathspec, not a filename: either way a single
`café.ts` or `:notes.txt` made the salvage's one `git add` exit 128 and discarded all of it. A
commit-less checkout no longer makes the probe throw, which is the scaffold-from-scratch case the
working-tree half was written for.

The generic `agent` failure hint no longer claims the step "failed after its automatic retries",
which it cannot know and which was wrong on the run that prompted this: it points at the step's own
attempt count and failure detail instead.
