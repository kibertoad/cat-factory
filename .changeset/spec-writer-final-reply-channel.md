---
'@cat-factory/agents': patch
'@cat-factory/server': patch
---

Require final-answer agents to emit the answer in the reply, not the reasoning channel.

A spec-writer run, then a blueprinter run, on `@cf/moonshotai/kimi-k2.7-code` failed
with "the agent did not return a usable ...: its final turn produced no text (an empty
completion)" even though the model produced a complete, valid document. The whole
answer landed in the model's reasoning channel and the visible reply came back empty
(telemetry: `finish_reason='stop'`, thousands of completion tokens, ~31k chars of
`reasoning_text`, zero visible content). The harness reads the deliverable from the
visible content only, so the no-empty-outcome gate (`unusableFinalAnswerCause`)
correctly failed the run.

This is universal to any agent whose deliverable IS its final reply. Added a shared
`FINAL_ANSWER_IN_REPLY` fragment (`@cat-factory/agents`, `prompts/shared.ts`) that
names the channel, and applied it to every final-answer agent: the four container
constants in `ContainerAgentExecutor.ts` (spec-writer, blueprint, merger, on-call), the
design/review/test standard phases, the tester report, the business-reviewer, the
companions, the requirements reviewer + rework, and the generic report roles
(researcher, analysis, bug-investigator, documenter, integrator, task-estimator,
merger). It is deliberately NOT applied to side-effect agents whose product is a pushed
commit (coder, ci-fixer, conflict-resolver, mocker, playwright, business-documenter):
they legitimately end with no final text. The spec-writer prompt also now states it has
no repository write access, removing the "maybe it just wants me to push the file"
reading. Bumped the `requirement-review`, `requirement-rework`, and `review` versioned
prompts. The no-empty-outcome gate stays as the safety net.
