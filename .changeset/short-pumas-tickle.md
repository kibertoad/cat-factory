---
'@cat-factory/contracts': minor
'@cat-factory/orchestration': minor
'@cat-factory/app': minor
'@cat-factory/conformance': patch
---

Give the initiative planner's human gate a real review surface.

`pl_initiative` marks the planner step `gate: true`, so the planning run parks on the same generic
`step.approval` every gated agent step uses — but two things made that gate a dead end, and only
together do they explain why. The planner emits its plan as JSON and returns a transcript summary
("Initiative plan drafted.") as `step.output`, so the gate parked on a **one-line proposal**: nothing
to navigate, nothing to anchor a comment against, and a "request changes" re-run that handed the
planner back a sentence rather than the plan it had just written. And the planner declared the
read-only tracker window as its result view, which has no approve / request-changes / reject rail —
so the run's own review surface offered nothing and the gate was resolvable only over REST. The e2e
suite had this written down (`no SPA affordance exposes it for an initiative block`) and approved it
over HTTP to get past it.

Both halves are fixed **generically**, not with an initiative-specific window:

- The plan joins the spec doc and the blueprint tree on the existing `reviewableArtifactOutput` seam
  (`renderInitiativePlanForReview`), so the gate parks on a markdown rendering of the plan that was
  ingested. Its headings are load-bearing rather than cosmetic — the reader's outline parser splits
  the document at each one, so every phase and item becomes a navigable, collapsible section and a
  comment target. Downstream steps and the rework prompt read the same text.
- `initiative-planner` declares NO `resultView`, so its step opens the generic reader — outline
  navigation, per-block comments, overall feedback, approve / request changes / reject — exactly as
  the architect's does. Nothing is lost by not opening the tracker there: at the planning gate every
  item is still `pending` with no PR and the tracker's curation controls require `executing`, while
  the plan's descriptions, estimates and dependencies are not on the tracker at all. It remains the
  analyst's and committer's result view and keeps its card/inspector entry points.

The board no longer hides the gate either: the initiative card and inspector offer **Review plan**
(and the card pulses) whenever the planner is parked, mirroring the existing "Answer planning
questions" affordance for the interview.

**Behaviour change worth knowing about at review time:** "approve with corrections" is now REFUSED
for any step whose output is a rendering of an artifact it already produced — the new
`PipelineStep.outputIsRendered`, which today covers the initiative plan, the spec doc and the
blueprint tree. `approveStep` answers 422 with `details.reason: 'proposal_not_editable'` and the SPA
replaces the button with a note. This looks like a removal but is the opposite: those edits were
already being silently discarded, because the committed artifact is the ingested one and never the
text typed over its rendering. It only bites a deployment that gates a `spec-writer` or `blueprints`
step, where the affordance was accepting corrections and dropping them. Requesting changes is the
route for a correction.

An alternative considered and rejected: teaching the tracker window to render the plan and grow its
own review rail. That would have put a second, initiative-shaped copy of the approval machinery
beside the generic one, and it treats the symptom — the deeper problem is that **any** kind with a
dedicated result view that a pipeline gates loses its ability to be approved, which the generic
reader is precisely what solves.
