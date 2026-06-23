---
'@cat-factory/consensus': minor
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/agents': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': minor
'@cat-factory/worker': minor
'@cat-factory/node-server': minor
'@cat-factory/local-server': minor
'@cat-factory/app': minor
---

Add an optional consensus-orchestration framework + a core Task Estimator.

A new opt-in `@cat-factory/consensus` package lets an eligible agent step run through
a multi-model **consensus** process — a specialist panel, a debate, or ranked
voting/scoring — to produce a higher-quality result of the same shape the single-actor
agent would have (a polished document, an aggregate of observations, an estimate). It
integrates via the `AgentExecutor` seam: a `ConsensusAgentExecutor` wraps the standard
composite and delegates to it when a step isn't consensus-enabled or gating marks the
task ineligible. Eligibility is surfaced through a new group of assignable capability
traits (`specialist-panel-capable` / `debate-capable` / `ranked-voting-capable`); the
pipeline builder shows an "Enable Consensus" toggle (strategy, participants + models,
optional risk/impact gating) on eligible steps. Each session persists a full transcript
(`consensus_sessions`, both runtimes) rendered in a dedicated Consensus Session window
and streamed live via a new `consensus` workspace event; every sub-call flows to
`llm_call_metrics`. Wired per facade behind `CONSENSUS_ENABLED` (off ⇒ unchanged).

A new **core** `task-estimator` agent rates a task's Complexity/Risk/Impact (0..1) after
requirements are clarified; the engine persists it on `block.estimate` (new column on
both stores) and the inspector shows the ratings. It gates the expensive consensus step
and is useful standalone for triage.

BREAKING (pre-1.0, no migration): `Block` gains `estimate`, the pipeline + pipeline-step
shapes gain `consensus`, `AgentRunContext` gains `consensus` + `block.estimate`, and the
`WorkspaceEvent` union + `ExecutionEventPublisher` gain a consensus variant. Stale rows /
shapes simply re-create.
