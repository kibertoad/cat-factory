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
- Deleting an initiative block does not cascade the entity row.
- Reshaping the policy's pipeline-selection **rules** is not editable from the UI — only the two
  scalar knobs (`maxConcurrent`, `defaultPipelineId`) are inline-editable; changing the rules
  requires re-running `pl_initiative` to re-plan.
