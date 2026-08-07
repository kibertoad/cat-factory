---
'@cat-factory/agents': patch
'@cat-factory/kernel': patch
'@cat-factory/orchestration': patch
'@cat-factory/server': patch
---

Finish the built-in-agent strangler: every container agent kind the platform ships is now an
ordinary `registerAgentKind` entry, and both switches that shadowed the registry are deleted.

`buildKindBody` (`@cat-factory/server`) is one path — compose the prompt, resolve the kind's
`AgentStepSpec` off the registry, build the generic body — where it used to carry
`buildMigratedBuiltInBody`'s `switch (context.agentKind)` plus a read-only-set branch, a companion
branch and an implementer fallback. `coerceCustomResult` (`containerAgentResult.ts`) is one
`registry.mapStructuredResult(kind)` lookup where it used to be an `agentKind === …` chain. The two
hard-coded Sets that answered questions the registry should have answered are gone with them:
`CONTAINER_AGENT_KINDS` (replaced by the kind's declared `container-*` surface) and
`MULTI_REPO_FANOUT_BUILTIN_KINDS` (replaced by `fanOutMultiRepo` on the implementer and CI-fixer
registrations).

**Kernel (breaking, pre-1.0).** `AgentStepSpec.infra` (declared, never read) is replaced by
`testInfra: boolean`; the spec gains `image`, `localWrites`, and `clone.requirePr` /
`clone.prFallback` / `clone.mergeBase`. New: `AgentDispatchContext` (`baseBranch` / `workBranch` /
`multiRepo`), passed to a kind's `userPrompt` on a container dispatch and ABSENT for an inline
caller — the seam whose absence is why these kinds could not be registered before, since their
prompts have to name a branch and `AgentRunContext` describes the work rather than the checkout.

**Agents.** `AgentKindDefinition.systemPrompt` becomes optional (a built-in's shipped TRACK owns its
role text; a copy on the definition would be dead the day the track's wording moved), and gains
`userPromptSuffix` (append to the generic block-context prompt instead of replacing it — the
`on-call` agent reasons over the regression evidence that prompt carries) and `mapStructuredResult`
(the kind's own answer to which engine channel its JSON belongs in). `standardsDelivery` gains a
`none` tier for a kind that judges rather than produces. A suffix is applied OUTSIDE the revision
and injected-context wrappers, so a reply-shape instruction still ends the prompt on a revision
re-run and on the inline (no-checkout) path.

**Behaviour.** Parity was gated on the executor's existing per-kind snapshot suite, which drives
every kind through the public `startJob` and diffs the whole body: every body is byte-identical bar
one deliberate change. `merger` and `on-call` were bypassing the shared prompt chain, so they now
receive the effort-report guidance and — the actual bug — the skill and tool-server sections, which
a deployment's `assignSkills('merger', …)` had always been silently dropped from. `merger` declares
`standardsDelivery: 'none'` so joining that chain does not newly fold the service's coding standards
into a scoring prompt that never applies them.

What a deployment gets: the clone/PR/infra vocabulary the built-ins use is the public one, so an
org's own in-place fixer, tester or assessor is a registration rather than a fork.
