# ADR 0013: Initiatives; a long-running multi-task work container with JIT task spawning

- **Status:** Accepted (implemented)
- **Date:** 2026-07-05
- **Context layer:** backend + frontend (`@cat-factory/contracts`, `@cat-factory/kernel`, `@cat-factory/orchestration`, `@cat-factory/agents`, `backend/runtimes/*`, `@cat-factory/app`)

## Context

cat-factory orchestrates single tasks well (one block → one run → one PR) but had no construct
for a body of work too large for one task: a cross-cutting refactor, a migration, a strangler
conversion.

## Decision

Add **Initiatives**: a new `initiative`-level board block (a frame child, like a module) whose
**Initiative Planning pipeline** (`pl_initiative`) analyses the codebase, interviews the user on
goals/constraints, drafts a multi-phase plan requiring human approval, commits a structured
tracker into the repo, and then **executes the plan as a loop of ordinary tasks** (sequenced or
parallel per an agreed concurrency policy) until every tracker item is resolved.

Key shape decisions:

- **The codebase analysis runs BEFORE the interview.** The interviewer is an inline kind with no
  checkout, so an interviewer placed first can only ask the stakeholder to describe their own
  repository, which is what it did, spending its bounded rounds on facts the platform could read
  for itself. The read-only analyst leads instead, its prose is folded onto the entity
  (`analysisSummary`), and the interviewer is handed it with an explicit ban on re-asking anything
  it settles. The interview then covers only what no amount of code reading recovers: intent,
  priorities, risk tolerance, deadlines, and choices the code permits equally. The analyst closes
  its report with the open questions it could not settle, which is the interview's agenda.

  Two consequences follow from the ordering being a PIPELINE fact rather than a global one, and
  both are load-bearing. The analyst kind is shared with `pl_initiative_docs` (and any other
  `interview: 'skip'` preset), which has no interviewer at all, so its role prompt states only the
  duties that hold everywhere (read what is discoverable, close with the open questions) and the
  reason they matter is selected per run in the USER prompt from
  `AgentRunContext.initiative.interviewFollows`, read off the running chain. Either framing
  asserted unconditionally would be a plain falsehood on the other pipeline. Symmetrically, the
  interviewer's ban on codebase questions is a rule about where an ANSWER COMES FROM, so it holds
  only while an analysis is actually in hand: with none (an unreachable repo, an analyst that
  produced nothing, the gate driven outside `pl_initiative`) the prompt says the repository was not
  read and allows the questions back, keeping the human-only facts as the priority. The ban and the
  analysis fold share ONE predicate, so the role prompt can never claim a reading the task prompt
  does not carry.

- **Just-in-time task spawning**: the tracker is the source of truth; task blocks are created only
  when about to start, not up front.
- **No initiative-level pause gates**: spawned tasks run standard pipelines, which carry their own
  human gates and merge presets. Pipeline selection matches the planner-authored estimate
  (complexity/risk/impact) against the initiative's ordered policy rules, falling back to a
  default pipeline.
- **The DB row is the source of truth; the in-repo doc is a rendered projection.** The
  `initiatives` table (single-writer, rev-CAS) carries the entity; the committed
  `docs/initiatives/<slug>/{initiative.json,tracker.md,version.json}` mirror follows the existing
  blueprint artifact pattern (canonical JSON + sha256 + version manifest, hash-short-circuited
  idempotent commits).
- **The interview is entity-native**, not a generic `ReviewKind`: questions/answers/synthesized
  brief are stored directly on the `initiatives` entity's `doc` blob via the same `RunStateMachine`
  park/signal spine `ReviewGateController` uses, rather than in a parallel review table.
- **A blocked spawned item halts only its own phase** (non-terminal; siblings keep running) and
  raises a notification; a human retries/skips it to unstick the initiative.
- **The planning run is an ORDINARY run and is surfaced as one.** `pl_initiative` is a normal
  pipeline of normal agent steps, so the initiative block gets the same run surfaces a task does:
  the inspector's execution panel (step list, live phases, step-detail drill-down, Stop / Discard
  run) and the Focus view. Only the way a run is STARTED differs: an initiative block accepts
  exactly one pipeline, so it keeps a single "Run planning" control instead of the pipeline picker,
  on all three surfaces (board card, inspector, Focus). **That parity governs the run's PARKS too.**
  The planner step is `gate: true`, so a drafted plan parks the run exactly like any other gate:
  the card and the inspector carry the same `attention` affordance a task card does (resolved from
  `useInitiativePlanning`, with the interviewer's own park left to its "Answer planning questions"
  sibling), and the window that park ROUTES to (the tracker, per the planner's `resultView`)
  owns the approve / request-changes rail. Both halves are load-bearing: the gate first shipped
  with neither, so a finished plan sat behind a spinning "Run planning" and could be cleared only
  by a REST call. A park whose offer or whose resolving surface is missing is not "surfaced as one".
- **The plan gate parks on the PLAN, not on the planner's chatter.** The rail above can only be as
  good as what it reviews, and the planner emits its plan as JSON while returning a transcript
  summary ("Initiative plan drafted.") as `step.output`, so the gate parked on a one-line
  proposal, and a "request changes" re-run handed the planner that sentence back as its previous
  proposal rather than the plan it had just written. The gate now parks on a deterministic markdown
  RENDERING of the plan (`renderInitiativePlanForReview`). Its headings are load-bearing rather than
  cosmetic (the reader's outline parser splits the document at each one) which is what makes the
  rail's outline and its per-block commenting possible at all. Those two tools are the SAME ones the
  step reader gives the architect's prose: `useStepProse` for the outline, `useProseComments` for
  the anchoring, and one global `.reader-prose` sheet for the presentation, so the review surfaces
  cannot drift.
- **The step reader's LAYOUT is shared too, and it is what makes the review readable.** The first
  cut put the document in a card inside the tracker's scrolling column: the outline and the document
  split that column's width, the document was capped at a 20rem window, and the tracker's own goal /
  phases / policy / logs sections (the same plan, since the render reads the ingested entity)
  repeated underneath it. So while a rendered plan is parked, the review OWNS the window instead: the
  outline is a sidebar OUTSIDE the document, the document takes the window's full height, and the
  commands sit in an end-side rail. Replacing the tracker body rather than sitting above it is safe
  precisely because of the bullet above: the document IS the ingested plan, and everything the
  tracker adds on top (PR links, item curation, checkpoints, follow-ups) is execution-time state that
  cannot exist until the plan is committed. The exception is a gate carrying no rendering at all,
  where the tracker's sections are the only view of the plan there is: that one keeps a compact
  notice above them (`planReviewDocument` decides which, so the surface and its host cannot disagree
  about what is on screen). Two things about the takeover are easy to get wrong, and both were:
  - **A document-level affordance may not hang off the OUTLINE's existence.** The review hosts the
    window's run details (model, run id, token telemetry) in the outline column, so gating that
    column on `outline.hasToc` silently made "does this window still report what the run spent"
    depend on whether `renderInitiativePlanForReview` happened to emit a heading; an invariant in
    another package with nothing pinning it. The column's presence tracks its two contents
    independently; only the `<nav>` and collapse-all, which have nothing to act on without headings,
    stay behind that guard. The step reader keeps the same affordances outside its own for the same
    reason.
  - **The no-document notice renders ABOVE the entity branch, and is told whether the sections
    exist.** The gate lives on the RUN, so it is parked before `initiatives.load()` resolves; a
    notice nested under "the entity loaded" left that gate with no resolving surface at all, which
    is the bug the plan-review e2e spec exists for. Since it may then be sitting over a window with
    no sections, the sentence pointing at them is a separate key it only renders when they are
    really there.
- **What is rendered is the INGESTED plan, which is why this does not ride the generic artifact
  seam.** `reviewableArtifactOutput` renders the agent's RAW result, and that is sound only while
  the committed artifact IS that result: true of the spec doc and the blueprint tree, whose files
  the harness commits and the engine merely validates. The plan is the exception: what gets
  committed is derived at ingest, where a preset's phase template reorders phases and forces
  checkpoints, its `seedPlan` hook adds and drops items, and a re-plan carries over items a previous
  plan already materialised. Rendering the raw draft would therefore show the reviewer a document
  their approval does not govern: a silent failure, since nothing errors and the reviewer simply
  approves work they were never shown. So the `initiative-planner`'s post-completion resolver (the
  one component that knows what was committed) authors the rendering and publishes it through
  `StepResolution.outputIsRendered`. The renderer takes the shape the draft and the entity share
  (`InitiativePlanView`), and NOTHING it is handed is dropped: an item naming a phase the plan never
  declared gets its own section rather than vanishing between the phases.
- **The rendering is also what the re-plan quotes.** Because a "request changes" hands back the
  gate's proposal, the planner is re-prompted with the plan as committed rather than with its own
  pre-ingest draft: the two differ for exactly the presets above.
- **A rendered proposal is NOT editable, and the engine says so.** "Approve with corrections"
  rewrites `step.output`, which is right when the output is the agent's own prose and silently
  useless when it is a rendering of state already ingested: the committed artifact would stay
  the ingested one. Steps in that position carry `outputIsRendered`; `approveStep` refuses an
  edited proposal (422 `proposal_not_editable`) and the SPA hides the affordance. Requesting
  changes is the route for a correction.
- **A re-run re-interviews: the interviewer gate implements the spine's `resetForFreshRun`.** The
  entity outlives any one run, so on a fresh entry it drops the previous run's round bookkeeping and
  still-pending questions, keeping the answered + dismissed digest (which is also where a preset
  form's seeded exchanges live). Without it a run that burned its rounds leaves the entity at
  `interview.round >= maxRounds`, so the next run's first pass is force-converged and the human is
  never asked anything again: a wedged plan that no re-run could unwedge.

## Rationale

- Exploring before interviewing costs nothing the pipeline was not already going to spend (the
  analyst always ran) and converts the interview from a codebase quiz into the one thing a human is
  actually the authority on. The alternative (telling the interviewer to be more careful while
  leaving it first) cannot work: it has no checkout, so there is no source but the human to reach
  for. The trade-off accepted is that a run now spins up the analyst container before the human is
  first asked anything, so an initiative abandoned during the interview has already paid for one
  exploration.
- JIT spawning avoids maintaining a stale up-front task tree as the plan and codebase evolve.
- Letting spawned tasks carry their own pipeline gates/merge presets (rather than adding a second,
  initiative-level gate) avoids duplicating governance the engine already has.
- Entity-native interview storage honours "the DB row is the source of truth," keeps interview
  semantics honest (no severity/dismiss/document-replaces-description machinery it doesn't need),
  and avoids a heavy parallel table + repo + conformance surface for a single consumer.
- Single-writer `rev`-CAS on every mutation (including the execution loop's own tick) prevents races
  between a live loop tick and a concurrent human edit (promote/dismiss/retry/skip).
- Halting only the affected phase (not the whole initiative) on a blocked item lets independent
  work keep progressing while a human intervenes on the stuck one.

## Alternatives considered

- **Modelling the interviewer as a generic `ReviewKind`** (a parallel review table, like the
  requirements reviewer): rejected in favour of storing the interview directly on the initiative
  entity, since a `ReviewKind`'s severity/dismiss/document-replaces-description semantics don't fit
  an open-ended goal-clarification interview, and a second heavy table would duplicate what the
  entity's own CAS `doc` blob already provides.

## Consequences

- An initiative spans exactly one service frame / repo: cross-repo initiatives are out of scope.
- Deleting the initiative block IS how an initiative is deleted: the removal cascade reclaims the
  entity row with it, and the tasks the loop already spawned survive (they are not descendants;
  only their membership link is detached). The inspector's delete control therefore names the
  initiative, not the frame it hangs off.
- Reshaping the policy's pipeline-selection **rules** is not editable from the UI: only the two
  scalar knobs (`maxConcurrent`, `defaultPipelineId`) are inline-editable; changing the rules
  requires re-running `pl_initiative` to re-plan.
