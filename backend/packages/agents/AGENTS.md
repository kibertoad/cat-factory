# `@cat-factory/agents` — agent catalog + prompt composition + AI provisioning

**Entry:** `src/index.ts`.

**Where things live:**

- `agents/` — the agent catalog + per-kind roles: `catalog.ts`, `kinds/` (per-kind definitions
  - `versions.ts`, the versioned prompts — bump the number when you edit one), `prompts/`
    (`systemPromptFor`/`userPromptFor`; the shared fragments incl. `FINAL_ANSWER_IN_REPLY` in
    `prompts/shared.ts`), `runtime/` (`runRepoOps` — the custom-agent pre/post-op runner).
- `providers/` — the **AI provisioning facade**: `registry.ts` (`CompositeModelProvider`),
  `resolvers.ts` (the runtime-neutral single-provider resolvers), `endpoints.ts`
  (`providerEndpoints` — the base-URL/key source of truth, also used by the LLM proxy).
- `fragmentLibrary/` — the prompt-fragment library plumbing.
- `repo-ops/` — the checkout-free `RepoFiles` renderers for custom-agent artifacts.
- `presets/` — built-in initiative-preset pilots. `docs-refresh/docs-detect.logic.ts` is the
  deterministic, checkout-free repo probe (`detectDocsLayout`) behind the docs-refresh preset's
  form prefill (see `docs/initiatives/initiative-presets-and-docs-refresh.md`).
  `tech-migration/` holds the technological-migration preset's pieces: `phases.ts` (the canonical
  `MIGRATION_PHASE_IDS` contract shared by the template / prompt pack / plan post-processor / E2E)
  and `prompt-additions.ts` (`MIGRATION_PROMPT_ADDITIONS` — the per-planning-kind methodology
  steering the registration spreads onto its `promptAdditions`; see
  `docs/initiatives/tech-migration-preset-and-mssql-postgres-pilot.md`).

**See also:** `CLAUDE.md` → "Custom agents", "Conventions" (the `FINAL_ANSWER_IN_REPLY` rule);
`backend/docs/model-support.md`.
