---
'@cat-factory/orchestration': minor
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/agents': minor
'@cat-factory/app': minor
'@cat-factory/node-server': minor
'@cat-factory/worker': minor
'@cat-factory/server': patch
'@cat-factory/executor-harness': patch
---

Put the platform's captured evidence on the pull request: the pre-PR validation run, the bugfix
reproduction proof, and direct links to the artifacts the report lists.

Two of the strongest things this platform does were invisible to the only audience that matters.
The executor-harness has always run the service's own check commands against the exact tree that
opens a PR, and has run the declared reproducing test against the pre-fix tree and the finished one
— but both landed on the step record and nowhere a reviewer looks. The verification report now
carries them.

**Pre-PR validation** is reported as its own section: each command, its exit code and duration, and
the captured log of whatever failed. It is deliberately kept apart from the `ci` section, because
they answer different questions: CI is the host's opinion of the pushed branch, on another machine
and later, while this is the platform's own run of the service's commands on the exact tree that
was pushed, and the one verdict the platform ENFORCED (only a green checkout opens a PR). A passing
command's log is dropped and the section says so in as many words: ten green logs would cost the
body budget that makes the failing one readable, and an unexplained empty tail would read as "the
command printed nothing".

**The reproduction proof** is reported as red-then-green or not at all. Only failing-on-the-pre-fix
tree and passing-on-this-one is proof; anything else is `inconclusive`, stated plainly, with the
producer's own diagnosis rendered verbatim rather than re-derived from the exit codes (a green
pre-fix tree can mean the test misses the defect, or that a resumed run's base already carried this
step's own work, and only the side that ran the two trees can tell those apart). A run whose bug
genuinely cannot be reproduced in a test publishes the agent's structural declaration with its
reason and what it verified instead, which is never the same thing as nobody having tried. The
verdict also surfaces in the app, on both the result-window shell and the step-detail card — both
are needed, because the proof is recorded on whichever step opened the PR, and in every built-in
pipeline that is the `coder`, a kind with no dedicated result view.

**Captured artifacts are now reachable.** Each screenshot row carries a direct link to its bytes on
the deployment's own authenticated blob endpoint, built from a new `apiBaseUrl` dependency
(`PUBLIC_URL` on Node and local, `WORKER_PUBLIC_URL` on the Worker) rather than from the SPA origin
beside it: the two coincide on a same-origin deployment and diverge the moment the SPA is served
from its own host. The artifact id stays in the row — it is what an operator greps the store for —
and a deployment that configures no backend URL gets the id with no link rather than a link to
nowhere. The endpoint stays authenticated, so a report on a public repository does not make the
bytes reachable by an unguessable URL.

Two supporting changes. Captured command output is fenced through a new kernel
`hostMarkdown.outputBlock`, whose fence is sized one tick longer than the longest backtick run in
the log: a fixed three-tick fence closes on the first run a linter or a snapshot test prints, and
everything after it — the rest of the log, the sections below, and the machine-readable JSON block
— lands in the body as prose. And `pl_bugfix` gained a `repro-test` step before its `coder`, so the
manual bugfix preset produces a red test before the fix regardless of this feature; the version bump
offers the reseed to existing workspaces.

The report's JSON `version` goes to 5 for the two new sections and the artifact `url` field. The
`coder.reproductionProof` tri-state is now a task-facing control, deferred until the behaviour it
promises actually existed.
