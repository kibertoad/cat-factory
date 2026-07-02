# `@cat-factory/agents` — agent catalog + prompt composition + AI provisioning

**Entry:** `src/index.ts`.

**Where things live:**

- `agents/` — the agent catalog + per-kind roles: `catalog.ts`, `kinds/` (per-kind definitions
  plus `versions.ts`, the versioned prompts — bump the number when you edit one), `prompts/`
  (`systemPromptFor`/`userPromptFor`; the shared fragments incl. `FINAL_ANSWER_IN_REPLY` in
  `prompts/shared.ts`), `runtime/` (`runRepoOps` — the custom-agent pre/post-op runner).
- `providers/` — the **AI provisioning facade**: `registry.ts` (`CompositeModelProvider`),
  `resolvers.ts` (the runtime-neutral single-provider resolvers), `endpoints.ts`
  (`providerEndpoints` — the base-URL/key source of truth, also used by the LLM proxy).
- `fragmentLibrary/` — the prompt-fragment library plumbing.
- `repo-ops/` — the checkout-free `RepoFiles` renderers for custom-agent artifacts.

**See also:** `CLAUDE.md` → "Custom agents", "Conventions" (the `FINAL_ANSWER_IN_REPLY` rule);
`backend/docs/model-support.md`.
