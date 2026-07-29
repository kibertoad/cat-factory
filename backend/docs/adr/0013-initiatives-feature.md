# ADR 0013: Initiatives — a long-running multi-task work container with JIT task spawning

- **Status:** Accepted (implemented)
- **Date:** 2026-07-05
- **Context layer:** backend + frontend (`@cat-factory/contracts`, `@cat-factory/kernel`, `@cat-factory/orchestration`, `@cat-factory/agents`, `backend/runtimes/*`, `@cat-factory/app`)

## Context

cat-factory orchestrates single tasks well (one block → one run → one PR) but had no construct
for a body of work too large for one task — a cross-cutting refactor, a migration, a strangler
conversion.

## Decision

Add **Initiatives**: a new `initiative`-level board block (a frame child, like a module) whose
**Initiative Planning pipeline** (`pl_initiative`) interviews the user on goals/constraints,
analyses the codebase, drafts a multi-phase plan requiring human approval, commits a structured
tracker into the repo, and then **executes the plan as a loop of ordinary tasks** — sequenced or
parallel per an agreed concurrency policy — until every tracker item is resolved.

Key shape decisions:

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
  run) and the Focus view. Only the way a run is STARTED differs — an initiative block accepts
  exactly one pipeline, so it keeps a single "Run planning" control instead of the pipeline picker,
  on all three surfaces (board card, inspector, Focus).
- **The plan gate is an ORDINARY approval gate too, reviewed on the plan itself.** The planner
  step is `gate: true`, so it parks on the generic `step.approval` every gated agent step uses —
  but the planner emits its plan as JSON and returns a transcript summary as its output, and it
  declared the read-only tracker window as its result view. Between them the gate parked on a
  one-line proposal and opened on a surface with no approve / request-changes / reject rail, so
  it was resolvable only over REST. Both halves are fixed generically rather than with an
  initiative-specific window: the plan joins the spec doc and the blueprint tree on the
  `reviewableArtifactOutput` seam (so the gate parks on a markdown RENDERING of the ingested
  plan, which is also what a "request changes" re-run quotes back to the planner), and the
  planner declares NO result view so it opens the generic reader — outline navigation,
  per-block comments, feedback, approve / request changes / reject. The tracker stays the
  analyst's and committer's view and keeps its board-card and inspector entry points; it is the
  wrong surface at the gate anyway, since at planning time every item is `pending` with no PR and
  its curation controls require `executing`.
- **A rendered proposal is NOT editable, and the engine says so.** "Approve with corrections"
  rewrites `step.output`, which is right when the output is the agent's own prose and silently
  useless when it is a rendering of state already ingested — the committed artifact would stay
  the ingested one. Steps in that position carry `outputIsRendered`; `approveStep` refuses an
  edited proposal (422 `proposal_not_editable`) and the SPA hides the affordance. Requesting
  changes is the route for a correction.
- **A re-run re-interviews: the interviewer gate implements the spine's `resetForFreshRun`.** The
  entity outlives any one run, so on a fresh entry it drops the previous run's round bookkeeping and
  still-pending questions, keeping the answered + dismissed digest (which is also where a preset
  form's seeded exchanges live). Without it a run that burned its rounds leaves the entity at
  `interview.round >= maxRounds`, so the next run's first pass is force-converged and the human is
  never asked anything again — a wedged plan that no re-run could unwedge.

## Rationale

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
  requirements reviewer) — rejected in favour of storing the interview directly on the initiative
  entity, since a `ReviewKind`'s severity/dismiss/document-replaces-description semantics don't fit
  an open-ended goal-clarification interview, and a second heavy table would duplicate what the
  entity's own CAS `doc` blob already provides.

## Consequences

- An initiative spans exactly one service frame / repo — cross-repo initiatives are out of scope.
- Deleting the initiative block IS how an initiative is deleted: the removal cascade reclaims the
  entity row with it, and the tasks the loop already spawned survive (they are not descendants —
  only their membership link is detached). The inspector's delete control therefore names the
  initiative, not the frame it hangs off.
- Reshaping the policy's pipeline-selection **rules** is not editable from the UI — only the two
  scalar knobs (`maxConcurrent`, `defaultPipelineId`) are inline-editable; changing the rules
  requires re-running `pl_initiative` to re-plan.
