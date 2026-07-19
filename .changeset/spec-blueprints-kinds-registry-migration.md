---
'@cat-factory/agents': minor
'@cat-factory/server': patch
'@cat-factory/orchestration': patch
---

Migrate the `blueprints` and `spec-writer` container agent kinds onto the public
`registerAgentKind` seam (refactoring-candidates.md #5, the manifest-driven agent-kind
strangler).

Their role/system prompts, structured shape hints, and per-kind user-prompt builders
(`blueprintUserPrompt` / `specWriterUserPrompt`) move from `@cat-factory/server`'s
`agents/prompts.ts` down into `@cat-factory/agents` (`agents/kinds/spec-blueprints.ts`),
where each is registered as a read-only structured `container-explore` kind (blueprints
clones the PR branch; spec-writer clones the per-block work branch with
`failOnUnusableFinal`). Their kind-id constants (`BLUEPRINTS_AGENT_KIND` /
`SPEC_WRITER_AGENT_KIND`) now live next to the definitions and are re-exported by
orchestration's `ci.logic.ts` for the engine's existing call sites — the same pattern the
inline reviewer/brainstorm ids use.

The generic `registry.agentStep(...)` dispatch path in the server's `buildKindBody` now
renders their job body, so **both cases are deleted from `buildMigratedBuiltInBody`** and
the pair are removed from `CompositeAgentExecutor`'s hard-coded `CONTAINER_KINDS` set
(container routing now derives from `registry.requiresContainer()`). Their result coercion
still keys off their id in `toRunResult` (`blueprintService` / `spec`), and their
deterministic render/commit post-ops stay in the engine's built-in map (their commit branch
is resolved specially), so engine behaviour is unchanged.

Because their prompts now resolve through `systemPromptFor`/`userPromptFor` like any
registered kind, the surface-driven directives and declared traits are applied centrally
rather than being bypassed by the old bespoke constant: the observable prompt change is that
both kinds now carry the standard read-only guardrail (matching every other
`container-explore` kind), `blueprints` now also carries its declared `spec-aware` guidance,
and both fold in the block's selected best-practice fragments — the enrichment every other
kind already received. Both the final-answer directive AND the read-only guardrail are now
applied once from the surface (removed from the hand-written constants): `SPEC_WRITER_SYSTEM_PROMPT`
no longer restates the write-prohibition the central `READ_ONLY_GUARDRAIL` owns, matching
`BLUEPRINT_SYSTEM_PROMPT` (which never hand-embedded one) so read-only has a single source of truth.
