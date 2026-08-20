---
'@cat-factory/prompt-fragments': minor
'@cat-factory/executor-harness': minor
'@cat-factory/agents': minor
'@cat-factory/kernel': minor
'@cat-factory/orchestration': minor
'@cat-factory/consensus': minor
'@cat-factory/server': minor
---

Close the remaining actionable Kaizen findings: what the companion loop is told, and what a prompt
pays for on every round.

Six items the platform's own graders filed, all of them either a fact the prompt withheld or a
fact it paid for twice.

- **A companion was never told its bar on the first round.** The threshold rode the prior-rounds
  heading, and there is no prior round the first time a step is graded, so the opening verdict of
  every rework loop was a 0..1 rating against a number nobody had stated. The bar and the rope left
  are now their own slice of the run context, set for every grader dispatch.
  `priorReview.roundsRemaining` was the old home and is gone rather than left beside the new one.
  The ROPE needed a second fix to be true: the rework budget was adopted from the task's risk policy
  on the first grading RESULT, one dispatch after the prompt for that grading is composed, so a
  workspace whose policy allows no automatic rework was told on round one that two rounds remained.
  It is resolved once now, at run start, which also removes the second resolution point so the
  number an agent is shown and the number the cap enforces cannot diverge.
- **A rework prompt re-sent every settled point that was still open.** A point the reviewer raises
  again arrives once as this round's ask and again in the history; on a real run the same six points
  appeared three times with no single list to work through. The history is now deduplicated against
  the current round's list, and the fold is COUNTED in place rather than silent: a round whose every
  point moved into the current list would otherwise read as a round that raised nothing. A point NOT
  re-raised survives in the history, which is the only place it exists. Matching is on the point's
  BODY under its anchor rather than on the anchor alone, because an `anchorId` names an ITEM and one
  item collects several findings: keyed on the anchor, two different asks on one requirement hash
  together and re-raising one drops the other from the prompt for good.
- **The user prompt was assembled volatile-first.** A provider's cache matches on a prefix, and the
  injected context files (a preOp's output, the run's linked documents) are the largest block in the
  prompt and the same bytes on every round, while the revision feedback is different bytes by
  definition. They were composed the other way round, so each round paid a fresh cache write for the
  whole fold. The wrappers are now an ordered list, invariant material first, which is also what
  makes the ordering reviewable rather than five levels of nesting. The saving is the PRODUCER's
  rework dispatch: `priorOutputs` renders at the tail of the base prompt ahead of every wrapper and
  carries the producer's rewritten reply, so a GRADER's prefix still breaks before the fold. That
  bound is recorded at the code rather than implied away.
- **A container-backed companion could not run the diff its prompt asked for.** The default explore
  clone is `--depth 1 --single-branch`, so `origin/<base>` and the merge base are both absent and no
  later `git fetch` of a shallow base recovers a common ancestor. It clones with full history now,
  the same reason the `merger` does, and the dispatch's resolved base branch is named in the prompt
  with the diff commands and the rule that the review is planned from the diffstat before anything
  is opened. A measured review spent ~40 exploratory calls discovering the change one file at a
  time. The prompt names no `git fetch`, because the container agent holds no git credential of its
  own and an agent-issued fetch fails on a private repo; it is WITHHELD entirely where the checkout
  is the base branch (a `pr` clone falls back there when the producer opened no pull request, and
  the diff would be empty), and where the base branch name cannot be safely quoted into a command.
- **Trait guidance naming an injected file is gated on the file arriving.** The two foundational
  sections each open by pointing at a `.cat-context/` path the engine injects only where a
  `FoundationalServiceResolver` is wired; on a deployment with none they were a few hundred words of
  dangling pointer on every turn. `AgentTraitDefinition.guidance` now receives what the dispatch
  delivered and may decline to contribute. An absent delivery means UNKNOWN rather than empty and
  renders in full, so the prompt editor and the sandbox are unchanged, which makes
  `appendedDirectivesFor` a maximum rather than a prediction of one dispatch: a real dispatch may
  send a subset and never more. `BINARY_OUTPUT_GUIDANCE` is deliberately not gated, because its
  absent case is a refusal the agent has to be told about.
- **New `deployment.*` best-practice fragments.** Three standards for shipping a containerized
  service (image build and publish, workload runtime hardening, the cross-file manifest contract),
  from the class of finding a design review kept re-deriving one round at a time: a numeric UID for
  `runAsNonRoot`, a writable mount for a read-only root filesystem, pull-side registry auth, pull
  policy against tag mutability, and the selector/label/port contract three files share. They are
  OPT-IN: nothing shipped selects them, because there is no deploy-shaped built-in task type and
  unioning them onto `feature` would fold deployment standards into every feature run everywhere.

Runner image: the explore path's warm-pool checkout refreshed only the branch being explored,
leaving `origin/<base>` at whatever tip the pool directory was first cloned with, so a reviewer's
three-dot diff resolved its merge base to that stale tip and reported every commit merged into base
since as part of the change under review. Fixed in `@cat-factory/executor-harness`, so the pinned
image tag moves to `1.128.0`.
