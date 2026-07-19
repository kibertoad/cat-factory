---
'@cat-factory/agents': minor
'@cat-factory/server': patch
---

Migrate the `initiative-analyst` and `initiative-planner` container agent kinds onto the
public `registerAgentKind` seam (refactoring-candidates.md #5, the manifest-driven
agent-kind strangler).

Their role/system prompts, structured shape hint, and per-kind user-prompt builders
(`initiativeAnalystUserPrompt` / `initiativePlannerUserPrompt`, now exported) move from
`@cat-factory/server`'s `agents/prompts.ts` down into `@cat-factory/agents`
(`agents/kinds/initiative.ts`), where each is registered with an `agent` `AgentStepSpec`
(`container-explore`, base-branch clone; the planner structured with
`failOnUnusableFinal`). The generic `registry.agentStep(...)` dispatch path in the server's
`buildKindBody` now renders their job body, so **both cases are deleted from
`buildMigratedBuiltInBody`** and the pair are removed from `CompositeAgentExecutor`'s
hard-coded `CONTAINER_KINDS` set (container routing now derives from
`registry.requiresContainer()`).

Because their prompts now resolve through `systemPromptFor`/`userPromptFor` like any
registered kind, the surface-driven directives (the read-only guardrail +
final-answer-in-reply) are applied centrally rather than hand-embedded in the constants —
the only observable prompt change is that the two read-only explore kinds now carry the
standard read-only guardrail, matching every other `container-explore` kind. Behaviour is
otherwise unchanged; the planner's result coercion still keys off its id in `toRunResult`
(folding that onto the definition is the remaining slice).
