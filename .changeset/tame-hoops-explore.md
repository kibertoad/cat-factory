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
- `pl_initiative` is reseeded (version 5) with a new description. `pl_initiative_docs` is unchanged
  — it never had an interviewer and already led with the analyst.
- The technological-migration preset's interviewer steering no longer asks for the operational
  surface (scheduled jobs, ops tooling, monitoring, CI); its analyst already inventories that.
