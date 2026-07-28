# `@cat-factory/agents` — agent catalog + prompt composition + AI provisioning

**Entry:** `src/index.ts`.

**Where things live:**

- `agents/` — the agent catalog + per-kind roles: `catalog.ts`, `kinds/` (per-kind definitions
  - `versions.ts`, the versioned prompts — bump the number when you edit one), `prompts/`
    (`systemPromptFor`/`userPromptFor`; the shared fragments incl. `FINAL_ANSWER_IN_REPLY` and
    the sentinel-file guidances — `EFFORT_REPORT_GUIDANCE`, `FOLLOW_UP_GUIDANCE`, and
    `PR_DESCRIPTION_GUIDANCE` (the reviewer briefing a PR-opening coding agent writes to
    `.cat-pr-description.md`, which the harness lifts onto the PR it opens) — in
    `prompts/shared.ts`), `runtime/` (`runRepoOps` — the custom-agent pre/post-op runner).
    `kinds/capabilities.ts` holds the agent-CAPABILITY declaration vocabulary — the skill and
    tool-server (MCP) refs a kind declares, plus the pure normalisers `AgentKindRegistry` resolves
    them with (`skillsFor` / `toolServersFor`). `prompts/capabilities.ts` renders the tool-server
    prompt section (available servers + the ones this run could NOT wire). See ADR 0029.
- `providers/` — the **AI provisioning facade**: `registry.ts` (`CompositeModelProvider`),
  `resolvers.ts` (the runtime-neutral single-provider resolvers), `endpoints.ts`
  (`providerEndpoints` — the base-URL/key source of truth, also used by the LLM proxy).
- `fragmentLibrary/` — the prompt-fragment library plumbing.
- `skillLibrary/` — the repo-sourced Claude Skills catalog + sync (ADR 0024) and
  `SkillRunResolver`, which resolves ONE catalog skill (instructions + resource bodies at its
  pinned commit) for a dispatch. A BUNDLED skill needs none of this — it is deployment code,
  registered on `AgentKindRegistry.registerSkill`.
- `repo-ops/` — the checkout-free `RepoFiles` renderers for custom-agent artifacts, plus the
  built-in post-ops (`builtin.ts`: `blueprintPostOp`, `specPostOp`, and `specPromotionPostOp` —
  the tester-driven `aspirational` → `established` promotion of the in-repo spec) and
  `readServiceSpec.ts`, the checkout-free reassembly of the sharded `spec/` tree (read by the
  SPA's service-spec view in `@cat-factory/server`, the promotion post-op, and the PR
  verification report's requirement → evidence join in orchestration — hence it lives here,
  below all three).
- `presets/` — built-in initiative-preset pilots. `docs-refresh/docs-detect.logic.ts` is the
  deterministic, checkout-free repo probe (`detectDocsLayout`) behind the docs-refresh preset's
  form prefill (see `docs/initiatives/initiative-presets-and-docs-refresh.md`).
  `tech-migration/` holds the technological-migration preset's pieces: `phases.ts` (the canonical
  `MIGRATION_PHASE_IDS` contract shared by the template / prompt pack / plan post-processor / E2E)
  and `prompt-additions.ts` (`MIGRATION_PROMPT_ADDITIONS` — the per-planning-kind methodology
  steering the registration spreads onto its `promptAdditions`; see
  `docs/initiatives/tech-migration-preset-and-mssql-postgres-pilot.md`).

**See also:** `CLAUDE.md` → "Custom agents", "Conventions" (the `FINAL_ANSWER_IN_REPLY` rule);
`backend/docs/custom-agent-roles.md` (authoring a registered kind's prompt / skills / tool
servers on these seams); `backend/docs/model-support.md`.
