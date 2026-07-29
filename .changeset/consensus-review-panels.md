---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/agents': minor
'@cat-factory/consensus': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': minor
'@cat-factory/worker': minor
'@cat-factory/node-server': minor
'@cat-factory/app': minor
---

Open the consensus mechanism to the review agents, and make the panels a reusable, tiered library.

A review is a judgement, which is the thing a panel of independent models is measurably better at
than one model — but until now only the code `reviewer` among the review kinds could be run as
one. The deep PR reviewer and the document/design/spec companions are now eligible too. What a
panel can SEE differs by kind and is the reason the set stops where it does: `pr-reviewer` gets its
whole input from backend-prepared context files, which the inline prompt builder now folds in, so a
panel reads the same diff the container reviewer would; the checkout-exploring companions trade
ground-truth depth for judgement diversity, which is why consensus stays opt-in per step and gated
on the task estimate.

The gating is what made the feature hard to actually use: a panel costs several model calls, so
"run it only when the work is heavy" was already possible, but the panel itself had to be
hand-written onto each step. A workspace now keeps a library of **consensus groups** — named
panels (roles, perspective framings, models, strategy, synthesizer) each carrying the estimate bar
it is worth paying for. A step names a SET of groups, and at dispatch the engine picks the most
demanding tier the task's estimate clears, falling back to the standard single agent when none
does. "A two-model review above 0.4 risk, the full panel above 0.8" is one step instead of three
conditional pipelines, and the panels are shared across every pipeline in the workspace.

Two decisions worth knowing when reading the code. The tier is selected in the ENGINE, not in the
consensus executor, so the optional `@cat-factory/consensus` package never learns a group store
exists and the executor still consumes one already-decided config; and the selected group's gating
is deliberately dropped when it is materialised, because selection IS the gate — carrying it
forward would have the executor re-decide the same question against the same estimate, where any
future divergence silently turns a selected tier into a skipped step.

Running a container kind as an inline panel is where this feature's sharp edge is, and three
seams now carry that fact instead of assuming a filesystem. `dispatchDeliversCheckout` is the one
definition of "does this dispatch hand the agent a checkout", shared by the composite executor's
routing and by the engine, which passes it to a kind's repo hooks; the `pr-reviewer` diff renderer
branches on it, so a panel is never handed the manifest-plus-`git diff` shape it cannot act on and
anything that still does not fit its (larger) inline budget is named as unreviewable rather than
passed off as reviewed; and the consensus executor appends a directive stating the participant's
real surface, since the shipped prompts of most eligible kinds describe a machine the participant
is not on. The prompt fold that feeds inline callers is also bounded now, and leaves the standards
files to the system prompt, which folds them at the kind's configured verbosity.

Also fixes a silent pre-existing bug found next door: `ExecutionService` never forwarded
`agentPromptRepository` to the context builder, so a workspace's edited agent prompts never reached
a dispatch. The forwarding was a hand-maintained list of ~28 field names; it now passes the
dependency object it already has, which is why that class of omission can't recur.

Adds a `consensus_groups` table and two `consensus_sessions` columns (the tier that fired, recorded
by value so the transcript survives the library row being renamed or deleted) on both runtimes.
A workspace that authors no group is byte-for-byte unaffected.
