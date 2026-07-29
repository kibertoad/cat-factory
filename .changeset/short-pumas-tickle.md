---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
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

The gate now parks on a markdown rendering of the plan (`renderInitiativePlanForReview`). Its
headings are load-bearing rather than decorative: the reader's outline parser splits the document
at each one, which is what makes the rest possible. The tracker's rail renders that document with
an outline to navigate by and GitHub-style click-to-comment on any block, and sends the anchored
comments with the feedback — so a re-plan is quoted the planner's own text back at it.

**What gets rendered is the INGESTED plan, and that is the part worth a reviewer's attention.**
The obvious home for this was the existing `reviewableArtifactOutput` seam, beside the spec doc
and the blueprint tree. It is the wrong one: that seam renders the agent's RAW result, which is
sound only while the committed artifact IS that result — true for those two (the harness commits
the files; the engine only validates them), false for the plan, which the engine derives at
ingest. A preset's phase template reorders phases and forces checkpoints, its `seedPlan` hook adds
and drops items (the tech-migration preset caps coverage items and seeds a confidence case), and a
re-plan carries over items a previous plan already materialised. Rendering the raw draft would
show the reviewer a document their approval does not govern — and nothing would fail; they would
simply approve work they were never shown. So the `initiative-planner`'s post-completion resolver
authors the rendering off the entity it just committed, and publishes it through the new
`StepResolution.outputIsRendered`. The renderer takes the shape the draft and the entity share,
and drops nothing it is handed: an item naming a phase the plan never declared gets its own
section rather than disappearing between the phases.

Both review tools are the SAME ones the step reader gives the architect's prose, shared rather
than re-implemented: `useStepProse` for the outline, the new `useProseComments` for the anchoring
(the per-block half of `useStepApproval`, which now builds on it), and one global `.reader-prose`
stylesheet. The stylesheet absorbs the near-identical scoped copies the clarity, requirements and
brainstorm windows each carried, so all five reader surfaces now share one presentation — those
three pick up small cosmetic changes (the step reader's spacing and its code/blockquote styling)
in exchange for no longer being able to drift.

`useStepProse` also gained an explicit `leadAnchorId`. Its scroll-spy walks anchors in document
order and stops at the first one it cannot measure, so a consumer that renders the document alone
— this rail — had its active-section highlight silently pinned to the step reader's details card.

**Behaviour change worth knowing about at review time:** "approve with corrections" is now REFUSED
for any step whose output is a rendering of an artifact it already produced — the new
`PipelineStep.outputIsRendered`, which today covers the initiative plan, the spec doc and the
blueprint tree. `approveStep` answers 422 with `details.reason: 'proposal_not_editable'` and the
SPA replaces the button with a note. This looks like a removal but is the opposite: those edits
were already being silently discarded, because the committed artifact is the ingested one and never
the text typed over its rendering. It only bites a deployment that gates a `spec-writer` or
`blueprints` step, where the affordance was accepting corrections and dropping them. Requesting
changes is the route for a correction. The `task-estimator`'s summary deliberately stays editable
and the resolver now says why: the flag marks an output an edit cannot REACH, and that summary is
itself what downstream steps read via `priorOutputs`.

An alternative considered and rejected: routing the planner step to the generic step reader (by
dropping its `resultView`), which would have delivered the same tools with no new UI at all. It was
withdrawn once #1498 landed — that PR deliberately makes the tracker the window the park routes to,
and two review surfaces for one gate is worse than a slightly larger frontend diff.

One guard is new and worth keeping in mind when touching enum→i18n lookup tables: a key held in a
`Record<SomeEnum, string>` is invisible to BOTH i18n drift guards (typed message keys and
`i18n:check` only see a literal `t('a.b.c')`, and the exhaustive `Record` only proves every enum
member has an entry, never that the entry still names a live key). `test/i18nKeys` resolves such
values against the base catalog, and the initiative label tables now assert against it.
