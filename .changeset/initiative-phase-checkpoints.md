---
'@cat-factory/contracts': patch
'@cat-factory/orchestration': patch
'@cat-factory/agents': patch
---

Initiatives: phases can now declare a `checkpoint` (slice 2 of the
custom-initiative-definitions initiative). A checkpoint phase PAUSES the initiative for
human review once every one of its items settles, before the next phase spawns — so a
human can read the phase's committed output (e.g. a research doc + GO/NO_GO verdict) and
then resume to continue or cancel to stop. The engine never interprets an LLM verdict:
the pause is declarative phase data the loop reads, and resume is the acknowledgment.

- Contracts: `checkpoint?` on the plan/entity/draft phase and the preset phase-template
  phase, plus `checkpointClearedAt?` bookkeeping on the entity phase; a new `checkpoint`
  reason on the `initiative` notification.
- Ingest stamps a template-authored `checkpoint` onto the matched phase (forced on — the
  planner cannot unset it), honours a planner-authored one on any draft phase (generic,
  usable without a preset), and preserves `checkpointClearedAt` across a re-plan.
- The execution loop pauses at a completed, uncleared checkpoint phase (checked before
  completion, so a last-phase checkpoint still pauses) and raises the notification;
  `InitiativeService.resume` clears the checkpoint in the same CAS transform it resumes in.
- The in-repo tracker markdown annotates a checkpoint phase (pending vs cleared).

Non-checkpoint phases are byte-for-byte unchanged — a plan with no `checkpoint` advances
exactly as before.
