---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': minor
'@cat-factory/app': minor
---

Initiatives slice 2 — interactive planning.

The Initiative Planning pipeline (`pl_initiative`) now interviews the human and analyses the
codebase before the planner drafts, so the plan is grounded in the stakeholder's intent and the
real code. The pipeline becomes
`[initiative-interviewer → initiative-analyst → initiative-planner → approval gate → initiative-committer]`
(catalog `version` bumped to 2, so workspaces get the reseed offer).

- **`initiative-interviewer`** — a new inline LLM gate that asks clarifying questions about goals,
  scope and constraints, PARKS the planning run on a durable decision-wait while the human answers
  through a dedicated planning Q&A window, then synthesizes the agreed goal / constraints / non-goals
  brief. It is **entity-native**: the questions, answers and brief live directly on the `initiatives`
  entity (its `qa` + new `interview` fields) via the CAS `mutate` — no new table. Reuses the shared
  `RunStateMachine` park/answer/resume spine (the review-gate model). Passes through when no
  interviewer model is wired, so pipelines run unchanged.
- **`initiative-analyst`** — a new container-explore agent that reads the repo and writes a prose
  codebase analysis onto the entity (`analysisSummary`), grounding the plan.
- The **planner** and **analyst** prompts now fold in the interview brief + analysis (threaded onto
  the agent context for `initiative`-level runs).
- New endpoints (`POST /blocks/:blockId/initiative-planning/{answer,continue,proceed}`), store
  actions and the `initiative-planning` result-view window; the inspector surfaces an "Answer
  planning questions" button while the interviewer is parked. `initiative.planning.*` copy added to
  all locales.

Runtime-symmetric with no facade changes (the interviewer resolves its model exactly like the
requirements reviewer, from the routing default already wired in both runtimes) and no new
persistence — so no D1/Drizzle migration and no executor-harness image bump.
