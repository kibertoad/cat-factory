---
'@cat-factory/executor-harness': patch
'@cat-factory/local-server': patch
'@cat-factory/kernel': minor
---

Make a silently-failing agent run say what happened.

An agent step failed in local mode with `claude exited with code 1: ` — the exit code, a colon,
and nothing after it — plus `Phase timings: starting=0s, clone=1s, agent=564s. Failed in agent
phase; no tool had completed yet`. Every piece of evidence that would have identified it was
either discarded or unreachable: no watchdog had fired (so it was not classified as a hang), the
cold-start diagnostic recorded at the 120s mark had no consumer outside the container log, the
CLI's session transcript died with its per-run config home, and the container was removed the
moment the job settled. The retry succeeded, which is the worst outcome for diagnosis — nothing
left to inspect and no reason to believe it won't recur.

Three things now carry the evidence the harness already had:

**A bad CLI exit carries the CLI's own report.** Both agent CLIs report a terminal failure on
STDOUT inside their event stream — Claude Code's `result` event, Codex's last agent message — and
leave stderr EMPTY. `streamCli` rejected with the stderr tail alone, so an upstream refusal (quota,
rate limit, a provider outage the CLI retried out on) was rendered as an exit code and a dangling
colon, while the explanation sat in a local variable only the success path read. The rejection now
folds that report in, says `(no stderr output)` rather than trailing off, and names the SIGNAL when
one killed the process instead of rendering "code null" — which is the first fork in the road
between "the CLI gave up" and "something killed the container".

**The failure detail says how quiet the run had gone.** Exit status cannot distinguish a crash
from a stall: both are non-zero with an empty stderr. Phase timing plus silence can. The
breadcrumb now adds `silent for 564s`, or `no activity at all in 564s` when the run never
produced a byte — suppressed under 30s, and on an inactivity kill whose own message already states
the window it waited out, so it appears only where it changes the diagnosis. It is worded as
ACTIVITY rather than agent output because that is what the channel carries: the activity-silent
phases (dependency install, pre-PR validation, the reproduction proof, the frontend stand-up) feed
it synthetic keep-alive beats to hold the inactivity watchdog off, so a run that beat every 30s
through its install and then died has been heard from even though the agent never spoke.

**The cold-start diagnostic reaches the run.** ADR 0026 D4 asks for it to be surfaced on the step;
it was recorded on the job view and logged in the container, where a developer reading a failed run
in the SPA never sees it. It is now folded into the failure `detail`, the one failure field the
backend already carries onto the step — no new field on every transport hop. Surfacing it on a
still-RUNNING view (the early warning) stays open as observability-logging-gaps slice 5.5.

The local runtime's native inline runner had the same defect in miniature: it runs
`claude -p --output-format json`, whose error JSON also lands on stdout, and its non-zero-exit
branch kept only stderr — so the in-band `is_error` check its caller performs was unreachable
exactly when the CLI exited non-zero. It now reports whichever stream spoke, scrubbed through
`redactSecrets` at the emit site: that message carries raw command output, and on this path stdout
holds the model's own text, which is strictly more exposed than the stderr the sibling in the
container harness was already redacting.

**`describeProcessExit` is a new kernel export**, the shared sentence for how a subprocess ended.
The `null`-code-means-signal distinction is operational knowledge rather than formatting, and it
was about to exist in two hand-written copies; a third and fourth transport (pooled runner, K8s
pod, native host process) report process exits too and should inherit it rather than rediscover
it. The executor-harness keeps a pinned copy because the container image can depend on no
workspace package — the same arrangement `host-markdown` has, held equal by a conformity test.

Behaviour change to be aware of: the non-zero-exit message shape is different (`(no stderr
output)`, a `killed by SIGKILL` variant, an appended report). Nothing classifies on it — the
backend reads the structured `failureCause`, and the string-fallback classifiers were deleted in
error-message-coverage I5 — but a human-facing string that appeared in past runs has changed.

Deliberately NOT changed: the failure still classifies as the generic `agent` cause. `llm-upstream`
exists and is documented as exactly this case, but the only signal available for it is the CLI's
`result` prose plus a `subtype` whose vocabulary is not contractual — classifying on that would
reintroduce the string matching I5 deleted, and a wrong structured cause is worse than a generic
one because the backend acts on it. Surfacing the report is what makes the follow-up decidable.
