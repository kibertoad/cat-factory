---
'@cat-factory/contracts': minor
'@cat-factory/orchestration': minor
'@cat-factory/app': minor
'@cat-factory/conformance': patch
---

Review the initiative plan as a document, not a wall of sections.

#1498 gave the planner's parked gate a board affordance and an approve / request-changes rail in
the tracker window. This is the other half: what that rail actually reviews.

The planner emits its plan as JSON and returns a transcript summary ("Initiative plan drafted.")
as `step.output`, so the gate parked on a **one-line proposal**. Three consequences, none of them
visible from the rail itself: there was no document to read (the plan was only ever the tracker's
structured sections beneath the rail), no way to navigate a long plan, no way to say WHICH part
needed changing — and, worst, "request changes" handed the planner back that sentence as its
previous proposal, so the re-plan was near-blind.

The plan now joins the spec doc and the blueprint tree on the existing `reviewableArtifactOutput`
seam (`renderInitiativePlanForReview`), so the gate parks on a markdown rendering of the plan that
was ingested. Its headings are load-bearing rather than decorative: the reader's outline parser
splits the document at each one, which is what makes the rest possible. The tracker's rail renders
that document with an outline to navigate by and GitHub-style click-to-comment on any block, and
sends the anchored comments with the feedback — so a re-plan is quoted the planner's own text back
at it.

Both tools are the SAME ones the step reader gives the architect's prose, shared rather than
re-implemented: `useStepProse` for the outline, the new `useProseComments` for the anchoring (the
per-block half of `useStepApproval`, which now builds on it), and one global `.reader-prose`
stylesheet lifted out of `AgentStepDetail`'s scoped block. That is what keeps the two review
surfaces consistent instead of merely similar.

**Behaviour change worth knowing about at review time:** "approve with corrections" is now REFUSED
for any step whose output is a rendering of an artifact it already produced — the new
`PipelineStep.outputIsRendered`, which today covers the initiative plan, the spec doc and the
blueprint tree. `approveStep` answers 422 with `details.reason: 'proposal_not_editable'` and the
SPA replaces the button with a note. This looks like a removal but is the opposite: those edits
were already being silently discarded, because the committed artifact is the ingested one and never
the text typed over its rendering. It only bites a deployment that gates a `spec-writer` or
`blueprints` step, where the affordance was accepting corrections and dropping them. Requesting
changes is the route for a correction.

An alternative considered and rejected: routing the planner step to the generic step reader (by
dropping its `resultView`), which would have delivered the same tools with no new UI at all. It was
withdrawn once #1498 landed — that PR deliberately makes the tracker the window the park routes to,
and two review surfaces for one gate is worse than a slightly larger frontend diff.
