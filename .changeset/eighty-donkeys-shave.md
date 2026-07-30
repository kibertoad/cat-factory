---
'@cat-factory/agents': minor
'@cat-factory/contracts': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': minor
'@cat-factory/app': minor
'@cat-factory/example-custom-agent': minor
---

Agent-kind variants: register an alternate prompt for an EXISTING kind programmatically

`AgentKindRegistry.registerVariant({ id, baseKind, systemPrompt | promptAddition })` lets a
deployment ship "the Coder, but test-first" without inventing an agent kind. A pipeline step
selects one through `stepOptions.agentVariantId`, so the step still records the base kind and every
behavioural decision — dispatch shape, guardrails, companions, gating, the palette — is unchanged;
only the prompt differs. The engine resolves the variant in the same once-per-dispatch place as a
per-workspace prompt override and emits it through the same field, so the engine-enforced
directives still apply on top and a workspace override still wins as the narrower tier.

The two bespoke container prompts (`merger`, `on-call`) moved from `@cat-factory/server` into
`@cat-factory/agents` alongside the inline-engine ones, and `builtInBaseSystemPrompt` is now
`shippedBasePromptFor` exported from there.
