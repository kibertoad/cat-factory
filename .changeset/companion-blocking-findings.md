---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/agents': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': minor
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

That vocabulary is also what a loop stopped EARLY as unproductive (`companionLoopStalled`) now
resolves against. Abandoning the rounds still on the budget takes the cap's park, so the reason is
re-decided for the abandoned budget instead of being assumed to be a spent one: a standstill is the
automation reporting that it gave up, an open `blocker` is not, and a stalled loop routinely carries
both (the run that motivated the stall rule had two must-fix items open the whole way). So an
unattended policy answers a stalled quality loop and still waits for a person on a blocked one.

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

**Every surface that a person or an integration answers this park from names the findings, because
the summary no longer can.** With the prose groups gone, three places were reading the review out of
a channel that stopped carrying it. The extra round a person grants at the cap loops the producer
back with the verdict's graded `comments` attached, as the automatic rework path already did, so the
round somebody just paid for names the points it is for. The `approval-gate` entry of
`GET /api/v1/runs/{runId}/decisions` gains a `blockingFindings` array (spec `1.53.0`, additive), so a
caller answering `resolve-exceeded` with `proceed` can read the must-fixes it would be overruling
rather than inferring them from a verdict paragraph. And a companion's findings anchor to a
structured item by id rather than by quoting prose, which the producer prompt was rendering against
an empty target: an anchored point now names its item, and a point that anchors neither way is
addressed to the proposal as a whole.

**A first batch of nothing but nits no longer costs a round.** The rule that spends one round on a
first review's findings asked only whether there were any, so a reviewer that followed its own
instruction (a `minor` is "never worth holding anything for"), rated work above the bar and attached
one polish note bought a full producer re-run plus a re-grading call. It now takes a point the
reviewer did NOT call a nit, and the prompt states what each level costs so the grade decides
something a reviewer can predict. An ungraded point still counts: its urgency is unknown rather than
known to be low.

The panel's verdict badge derives its `>=` / `<` glyph from the comparison rather than from
`passed`, which are no longer the same fact: a round held by an open blocker fails at a rating that
cleared its bar, and reading one off the other printed `95% < 80%` above the findings explaining it.
The cap prompt's stalled wording drops its claim about the rating for the same reason.

A severity read off a STORED row is narrowed through `isReviewCommentSeverity` rather than trusted:
the schema's `major` fallback runs on the model reply, which is the only thing it parses, so a level
retired from the vocabulary would reach an exhaustive `Record` and come back `undefined`. Such a
value now sorts with the ungraded, carries no mechanical force, and is NAMED as unrecognised on the
panel instead of being painted as a level nobody chose.

`REVIEW_SUMMARY_LAYOUT` is replaced by `REVIEW_FINDINGS_LAYOUT`; a deployment appending the old
constant to its own companion prompt should append the new one, and one relying on the shared
companion prompt needs no change. Website: kibertoad/cat-factory-website#60.
