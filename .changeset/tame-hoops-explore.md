---
'@cat-factory/orchestration': minor
'@cat-factory/kernel': minor
'@cat-factory/agents': minor
'@cat-factory/app': minor
---

Initiative planning now explores the repository BEFORE it interviews you.

`pl_initiative` ran `initiative-interviewer → initiative-analyst → …`, but the interviewer is an
inline kind with no checkout — so the only source it could reach for was the human, and it spent
its bounded rounds asking stakeholders to describe their own codebase (what frameworks are in use,
how a module is laid out, what test coverage exists) while the agent that could have read all of it
waited behind the park. The steps are reordered to `initiative-analyst → initiative-interviewer →
initiative-planner (gate) → initiative-committer`, and the analysis is folded into the interviewer's
prompt with an explicit ban on re-asking anything it settles.

Behaviour changes worth knowing about:

- The analyst container starts before the human is asked anything, so an initiative abandoned mid
  interview has already paid for one read-only exploration.
- The analyst now closes its report with an `## Open questions` section naming only what the code
  cannot settle; that section is the interview's agenda.
- The interview is restricted to what no amount of code reading recovers: intent, priorities, risk
  and downtime tolerance, deadlines, external commitments, and choices the code permits equally.
  The "recommend an answer" action is grounded in the analysis too.
- That restriction is a rule about where an ANSWER comes from, so it now lifts when there is no
  analysis to lean on (an unreachable repo, an analyst that produced nothing, the gate driven
  outside `pl_initiative`): the interviewer is told the repository was NOT read and may ask about
  it again, with the human-only facts still first. The ban and the analysis fold share one
  predicate, so the role prompt can never promise a reading the task prompt does not carry.
- `pl_initiative` is reseeded (version 5) with a new description. `pl_initiative_docs` keeps its
  steps — it never had an interviewer and already led with the analyst — but the shared analyst
  kind now learns from the running chain whether an interview actually follows it
  (`AgentRunContext.initiative.interviewFollows`) and states the matching reason to read
  exhaustively. Asserting "a stakeholder is interviewed after you" unconditionally would be false
  on every interview-less planning pipeline, including a deployment's own.
- The technological-migration preset's interviewer steering no longer asks for the operational
  surface (scheduled jobs, ops tooling, monitoring, CI); its analyst already inventories that.
- Both interview windows (initiative planning, document authoring) gained a `preparing` state.
  Neither gate leads its pipeline, so a running run used to read as "the interviewer is working on
  your answers" for the whole of a lead-in the human had not answered anything into — now the
  window says what is actually happening and the "Planning in progress" route into it stays
  available throughout.
