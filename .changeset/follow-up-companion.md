---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/agents': minor
'@cat-factory/orchestration': minor
'@cat-factory/integrations': patch
'@cat-factory/server': minor
'@cat-factory/app': minor
'@cat-factory/executor-harness': minor
---

Add the future-looking **Follow-up companion** to the Coder agent.

As the Coder works it now surfaces forward-looking items — genuine loose ends, useful
side-tasks it is deliberately not acting on, and clarifying questions — by appending them
to a `.cat-follow-ups.jsonl` sentinel file in its working directory. The executor-harness
tails that file and streams the items **out** on the job view (drain-on-read, like tool
spans), so a blinking **Follow-up companion** chip on the Coder step lights up the moment
the first item appears — while the container is still running.

A human triages each item at any point: file a follow-up as a tracker issue (GitHub Issues
/ Jira, via the existing `TicketTrackerProvider`), send it back to the Coder to address
after delivering the key task, answer a question, or dismiss it. The pipeline's following
steps do not start until **every** item is decided: an undecided follow-up or unanswered
question parks the run at the Coder's completion (a new `followup_pending` notification).
Once all are decided the engine loops the Coder for the queued / answered items (within a
per-step budget) before advancing. The companion is enabled by default on Coder steps and
disableable per step in the pipeline builder.

This is pure engine + run-step state (no new table) so it is runtime-symmetric across the
Cloudflare and Node facades — the cross-runtime conformance suite asserts the park →
decide → loop → advance behaviour on both. Wire contracts (`followUpItem` /
`followUpsStepState`, the `followup_pending` notification, the `follow-ups` result view),
the `streamFollowUps` harness job flag + `RunnerJobView.followUps` channel (with an
optional pool-manifest `followUpsPath`), and the `FOLLOW_UP_GUIDANCE` Coder prompt fragment
are added across the stack.

Bumps the executor-harness image (new src) — publish + redeploy to roll it out.
