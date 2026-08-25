---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': minor
'@cat-factory/observability-otel': minor
'@cat-factory/executor-harness': minor
---

Answering a Coder's question and RULING ON it are now different acts, and a decision the loop
budget throws away says so.

A local run spent three implementer passes and about €4 producing three commits that reworded one
comment about a Kubernetes Ingress class, and the fourth walked the wording back to roughly where
the second left it. Nothing was broken: every part behaved as designed, and the design was the bug.

The Coder asked a question nobody in the loop could answer (which IngressClass the target cluster
marks as default). Its answerer replied with a standing steer, the same string every time, because
that is all an unattended caller has. `resolution` did not exist, so the engine had exactly one
thing it could do with an answered question: fold it into another pass and tell the agent to apply
it. There was nothing to apply, so the agent did the only thing left and wrote its uncertainty into
the manifest comment, the README and the commit message, one wording per pass, re-raising the same
question under a new title each time. The loop ended on `maxLoops`, not on agreement, and then the
last round's answers were dropped in silence.

**`POST …/follow-ups/…/answer` takes an optional `resolution`.** `answered` (the default, and
byte-for-byte the old behaviour) means the reply carries something to apply and buys a pass.
`closed` means the reply rules on the question: it clears the gate identically, spends nothing, and
rides into every later rework prompt under a heading that says the topic is settled and must not be
re-argued in the code or the commit message. The answerer picks; the engine does not try to read the
difference out of prose, which it cannot do. The public-API surface moves to `1.60.0`; the SPA's
answer box gains a second button.

**Exhausting the send-back budget is no longer indistinguishable from converging.** The gate's
decision was a boolean whose `false` covered three different situations, one of which was "a
human's decision is about to be thrown away". It is now a named verdict, and the dropped items are
stamped `sendBackDropped`, warned about with the budget that ran out, counted under
`followup.send_back_dropped`, and reported on the pull request. Without the stamp such an item
stays `answered` with `sentToCoder` false forever, which reads exactly like an answer the Coder
applied.

**The PR verification report gains a `followUps` section** (payload `version: 10`): what the Coder
flagged and what was decided, with the three dispositions that mean "not dealt with as triage
intended" called out above the table rather than left to be derived from a status column.

**The acceptance suite closes questions instead of answering them.** It was the caller in the story
above, and its own file header had already reasoned through this exact failure for the clarity-review
gate. Its steer is a ruling, so it now sends one.

**Fixed alongside, and part of why the agent had so little to work from:** the single-repo coding
path dropped `job.contextFiles` on the floor. Every sibling caller forwarded them;
`buildSingleRepoCodingSpec` did not. So a task whose brief was too long for `description` (and
therefore rode an attached document, which is the documented way to submit a real specification)
reached the implementer as a prompt naming `.cat-context/<file>.md` beside a checkout that had no
such directory. The agent rebuilt the brief from whatever summary the prompt carried and filed the
gap as a follow-up question. Bumps the runner image to `cat-factory-executor:1.130.0`.
