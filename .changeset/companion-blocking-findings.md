---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/agents': minor
'@cat-factory/orchestration': minor
'@cat-factory/conformance': minor
'@cat-factory/app': minor
---

Hold a run while a companion's MUST-FIX finding is open, whatever the rating said.

A companion returned one number for a whole deliverable, and that number alone decided whether the
run moved on. So a reviewer that found something genuinely unshippable — an unhandled failure mode,
a requirement not met, a claim the work does not support — could still rate the change 0.9 against a
0.8 bar and watch the pipeline advance past it. The urgency it meant was in the summary prose, in
the `**Must fix**` group the prompt asked for, which is a channel only a person reads.

Reviews are now GRADED. Each point a companion raises is its own `comments` entry carrying a
`severity` of `blocker`, `major` or `minor` (the same three levels the prose groups named), and the
verdict's two halves are read independently by kernel's new `disposeCompanionVerdict`: any open
`blocker` reworks the producer whatever the rating, and the rating decides everything else. The
`summary` becomes a short whole-verdict paragraph rather than a second copy of the list, matching
what the judge prompt already does, since both are rendered together and a review written twice is
two orderings that can disagree.

**Spending the rework budget on a blocker parks for a person, and an unattended risk policy does not
answer that park.** ADR 0053's rule is that a policy may take the "proceed anyway" a person would
have been offered when an automatic loop reports it GAVE UP; a reviewer naming a must-fix is not
that, so accepting the work anyway would be overruling a review nobody read. The distinction is a
closed vocabulary (`CompanionParkReason`, the sibling of `JudgeParkReason`) rather than prose, and
only `budget_spent` reaches the policy. The run panel's cap prompt states which of the two it is,
because the person answering an unanswerable-by-policy park should know what they are being asked to
overrule.

An out-of-vocabulary severity from a model reads as `major`, the same "unreadable severity reads as
its safe default" rule the judge and PR-review findings use: the whole assessment is one parse, and
an unparseable companion verdict fails the run, which is far worse than one point landing a level
off. `major` and not either extreme, so a typo can neither manufacture a hard stop nor retire a real
one. A comment with no severity at all (a person's "request changes" note, or one recorded before
this existed) stays ungraded and never blocks.

The findings now render. Each verdict card in the run panel lists them worst first with a severity
badge beside each, which is new: `comments` were persisted and fed back into later rounds but shown
to nobody, so the point holding a run was invisible to the person being asked to resolve it. Both
sides of the rework loop read the grades too — the producer is told which comments are blocking and
works them first, and a re-grading companion sees its earlier rounds' points labelled.

`REVIEW_SUMMARY_LAYOUT` is replaced by `REVIEW_FINDINGS_LAYOUT`; a deployment appending the old
constant to its own companion prompt should append the new one, and one relying on the shared
companion prompt needs no change. Website: kibertoad/cat-factory-website#60.
