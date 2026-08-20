---
'@cat-factory/prompt-fragments': minor
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
  are now their own slice of the run context, set for every grader dispatch, and the anchored scale
  in the companion system prompt points at where the number is stated instead of leaving the anchors
  free-floating. `priorReview.roundsRemaining` was the old home and is gone rather than left beside
  the new one.
- **A rework prompt re-sent every settled point that was still open.** A point the reviewer raises
  again arrives once as this round's ask and again in the history; on a real run the same six points
  appeared three times with no single list to work through. The history is now deduplicated against
  the current round's list, matching on the finding's own anchor so a reworded re-raise is still one
  point, and the fold is COUNTED in place rather than silent: a round whose every point moved into
  the current list would otherwise read as a round that raised nothing. A point NOT re-raised
  survives in the history, which is the only place it exists.
- **The user prompt was assembled volatile-first.** A provider's cache matches on a prefix, and the
  injected context files (a preOp's output, the run's linked documents) are the largest block in the
  prompt and the same bytes on every round, while the revision feedback is different bytes by
  definition. They were composed the other way round, so each round paid a fresh cache write for the
  whole fold. The wrappers are now an ordered list, invariant material first, which is also what
  makes the ordering reviewable rather than five levels of nesting.
- **A container-backed companion could not run the diff its prompt asked for.** The default explore
  clone is `--depth 1 --single-branch`, so `origin/<base>` and the merge base are both absent and no
  later `git fetch` of a shallow base recovers a common ancestor. It clones with full history now,
  the same reason the `merger` does, and the dispatch's resolved base branch is named in the prompt
  with the two commands and the rule that the review is planned from the diffstat before anything is
  opened. A measured review spent ~40 exploratory calls discovering the change one file at a time.
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
  policy against tag mutability, and the selector/label/port contract three files share.
