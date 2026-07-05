---
'@cat-factory/contracts': minor
'@cat-factory/agents': minor
'@cat-factory/kernel': minor
---

Stack recipes & shared stacks (slice 8): the opt-in environment analyst.

Adds an `environment-analyst` agent kind — the LLM half of environment auto-detection. Where the deterministic detector reads a repo checkout-free and can only see mechanical facts (compose layering, external networks, env-file pairs), the analyst is a read-only `container-explore` agent that CLONES the repo and reads the imperative bring-up a scan can't (README / Makefile / `bin/*` CLIs / setup scripts / seed dumps) to draft a declarative Docker Compose stack recipe — setup steps, prerequisites and a health gate — each grounded in a source citation. It returns the draft on `result.custom` (rendered by the shared `generic-structured` view); it never writes the repo. The draft is NON-BINDING: the setup wizard (slice 7) will merge it over the deterministic recommendation and nothing is applied until the human confirms.

- Contracts: `AnalystRecipeDraft` / `AnalystRecipeNote` / `AnalystCitation` (`environment-analyst.ts`) — a lenient LLM-output shape (a proposed `StackRecipe` + per-field provenance + summary) that degrades field-by-field on a partially-malformed reply.
- Agents: the `environment-analyst` kind (registered through the public `AgentKindRegistry` seam, pre-loaded by `defaultAgentKindRegistry()`), with its schema-derived structured output (`failOnUnusableFinal`, so an empty reply fails loudly rather than yielding an empty draft).
- Kernel: a seeded analyst-only pipeline `pl_environment_analysis` (`ENVIRONMENT_ANALYSIS_PIPELINE_ID`) the wizard runs against a service frame, mirroring `pl_blueprint`.

No persistence change — the analyst rides the execution engine and the existing `provisioning` blob, so no migration and no runtime asymmetry. The draft-merge + wizard trigger UI land with the wizard (slice 7).
