# Handover — Requirements-Review experience improvements

Status snapshot for the in-progress feature work on the requirements-review flow. Full
design lives in `~/.claude/plans/let-s-improve-experience-of-buzzing-crystal.md`.

The original request had **5 asks** plus a cross-cutting **tech-spec writer/reviewer pair**
agreed during planning:

1. Remove the per-finding "Save answer" button (value just typed into the field).
2. Show a spinner on the board pipeline list while re-review/incorporation run; visualize companions.
3. Add a "Recommend something" option backed by a new **Requirement Writer** companion (repo-
   - standards- + web-grounded), reviewed by the human one by one.
4. Spec-writer incorporates **only business requirements**; "no new specs" is a valid outcome
   for technical tasks, and the spec reviewer corroborates it.
5. An explicit **technical** label on a task, set by hand or by the review agents, that makes
   the implementer treat the task definition (not specs) as primary.

Locked decisions (see the plan): Writer = inline LLM call + `RepoFiles` (no container/image
changes); recommendations are NOT AI-reviewed; web search = provider-hosted **and** a
UI-managed Brave/SearXNG gateway; answers auto-save on blur; a human-set `technical` label is
never overridden; accepted recommendations fold into the next incorporation; fragments
(team/org standards) are consulted FIRST and flagged as "current standard".

---

## ✅ Done and verified (items 1, 2, 3) — this PR

All backend packages build (`pnpm -r --filter './backend/**' build`, incl. both runtime
facades + conformance), and the Nuxt frontend `pnpm --filter @cat-factory/app typecheck`
passes. Changeset: `.changeset/requirements-review-recommendations.md`.

### Item 1 — auto-save answers (no button)

- `frontend/app/app/components/requirements/RequirementsReviewWindow.vue`
  - Removed the "Save answer" button. The answer `<UTextarea>` is seeded from `item.reply`
    (a `watch(review,…)`), persists on `@blur` via `persistDraft()` (only when changed), and
    `flushDrafts()` runs before `incorporate()`/`proceed()` so nothing typed is lost.
  - The standalone "recorded answer" box now only renders for non-editable findings.

### Item 2 — board progress for the review companions

- `frontend/app/app/composables/useReviewStage.ts` — `ReviewStage` gains `'recommending'`.
- `'Recommending…'` label added alongside `Incorporating…`/`Re-reviewing…` in:
  `components/pipeline/PipelineProgress.vue`, `components/board/nodes/TaskCard.vue`,
  `components/panels/inspector/TaskExecution.vue`. `BlockNode.vue` / `TaskPipelineMini.vue`
  suppress the approval via the generic `isBackground()` (handles the new stage for free).
- Companions already render as dashed sub-nodes in `PipelineProgress.vue` via
  `gateCompanionFor` / `COMPANION_STATE_META` (unchanged).

### Item 3 — "Recommend something" + the Requirement Writer (end-to-end)

**Contracts** (`backend/packages/contracts/src/requirements.ts`)

- `ReviewItemStatus` gains `'recommend_requested'` (counts as settled, not `open`).
- `RecommendationStatus`, `RequirementRecommendation` (snapshots the source finding by
  title/detail, carries `recommendedText`, `note`, `groundedInFragment`), and a
  `recommendations[]` field on `RequirementReview`.
- Request schemas: `requestRecommendationsSchema`, `reRequestRecommendationSchema`.
- Re-exported through `backend/packages/kernel/src/domain/types.ts`.
- Frontend mirror: `frontend/app/app/types/requirements.ts`.

**Persistence (both runtimes — parity)**

- D1: column added in `backend/runtimes/cloudflare/migrations/0009_requirement_recommendations.sql`;
  `D1RequirementReviewRepository` reads/writes `recommendations`.
- Node/Drizzle: `recommendations` column in `backend/runtimes/node/src/db/schema.ts`;
  `DrizzleRequirementReviewRepository` read/write; generated migration
  `backend/runtimes/node/drizzle/20260625130000_requirement_recommendations/`
  (hand-authored v1 snapshot+SQL — drizzle-kit needs a TTY this env lacks).

**Prompt** (`backend/packages/agents`)

- `WRITER_SYSTEM_PROMPT` in `src/agents/prompts/requirements.ts`; registered as
  `requirement-writer@v1` in `src/agents/kinds/versions.ts`; exported from `src/index.ts`.

**Service** (`backend/packages/orchestration/src/modules/requirements/`)

- `requirements.logic.ts`: `buildRecommendationPrompt` (grounding order fragments → spec/
  tech-spec → web), `coerceRecommendations`, grounding types.
- `RequirementReviewService.ts`: `recommend()`, `acceptRecommendation()`,
  `rejectRecommendation()`, `reRequestRecommendation()`, plus a `gatherGrounding()` helper.
  New optional deps: `resolveRunRepoContext`, `resolveBlockFragments`, `webSearch` — all
  degrade gracefully when unwired. Provider-hosted web search is attached via
  `providerWebSearchTools(ref.provider)` for Anthropic/OpenAI models.
- `container.ts` `createRequirementsModule`: wires `resolveRunRepoContext` (already in
  `CoreDependencies`) and an inline `resolveBlockFragments` (walks the frame chain for
  `serviceFragmentIds`, unions block `fragmentIds`, resolves via `getFragment`).

**Controller** (`backend/packages/server/src/modules/requirements/RequirementReviewController.ts`)

- `POST /blocks/:blockId/requirement-review/recommend`
- `POST /requirement-reviews/:reviewId/recommendations/:recId/{accept,reject,re-request}`

**Frontend**

- `composables/api/reviews.ts`: `requestRecommendations`, `acceptRecommendation`,
  `rejectRecommendation`, `reRequestRecommendation`.
- `stores/requirements.ts`: matching actions, a `recommending` Set + `isRecommending`, and
  `backgroundStage` returns `'recommending'` while the Writer runs.
- `RequirementsReviewWindow.vue`: a "Recommend something" toggle per finding, an action-rail
  "Request N recommendation(s)" batch button, and a recommendations review section with
  Accept/Reject, a re-request-with-note box, and a green **"current standard"** badge when
  `groundedInFragment` is set.

---

## ✅ Done and verified (items 4, 5) — branch `feat/business-only-specs-technical-label`

Workstream F is implemented + verified (backend `pnpm -r --filter './backend/**' build` green;
`@cat-factory/app` typecheck green; orchestration `test:run` 221 green incl. new
`technical.logic.test.ts`; Node conformance `test:run conformance` 96 green incl. 4 new
technical-label inference assertions, run against a throwaway `postgres:18-alpine`). Changeset:
`.changeset/business-only-specs-technical-label.md` (minor; no executor-harness image bump —
the spec-writer prompt lives in `@cat-factory/server`, not the harness). Not yet committed.

### Item 4 — business-only specs + "no new specs" outcome

- New `AgentRunResult.noBusinessSpecs` channel (`kernel/ports/agent-executor.ts`). `toRunResult`
  (`server/.../ContainerAgentExecutor.ts`) reads `{"noBusinessSpecs":true}` off the spec-writer's
  structured JSON, sets the flag, and skips the `spec` channel; `specPostOp`
  (`agents/repo-ops/builtin.ts`) no-ops when it's set. `SPEC_WRITER_SYSTEM_PROMPT` +
  `specWriterUserPrompt` + `SPEC_SHAPE_HINT` updated (business-only; "no specs" valid for
  technical tasks). Spec-writer prompt is NOT version-controlled, so no version bump.
- `companionAssessmentSchema` gains optional `technicalCorroborated` (`contracts/companion.ts`);
  the spec-companion prompt (`agents/prompts/companion.ts`) instructs it to corroborate/dispute
  the writer's determination and emit the flag.

### Item 5 — explicit `technical` label

- `Block.technical?: boolean | null` (`contracts/entities.ts` + frontend `types/domain.ts`);
  persisted on both runtimes (D1 `0010_block_technical.sql` + Drizzle column + hand-authored
  `drizzle/20260625140000_block_technical/` — a MERGED-head snapshot unioning the three branched
  `20260625130000_*` siblings; shared block mapper in `server/persistence/mappers.ts`). Patch +
  create schemas (`contracts/requests.ts`) + `BoardService.addTask`.
- Engine inference: `spec-writer` step records `step.noBusinessSpecs` (new `pipelineStepSchema`
  field); on spec-companion convergence `CompanionController` calls the engine's
  `inferBlockTechnical`, which uses the pure `inferTechnicalLabel` (`execution/technical.logic.ts`)
  — a human-set value is NEVER overridden.
- Implementer awareness: `AgentRunContext.block.technical` threaded by `AgentContextBuilder`;
  build SYSTEM prompt gains the rule (**`build` bumped v2→v3**) + a per-task
  `technicalContextSection` in the user prompt (`agents/prompts/standard.ts`).
- Frontend: creation checkbox (`AddTaskModal.vue`) + tri-state inspector toggle
  (`TaskRunSettings.vue`, unset/technical/business).

**drizzle-kit `db:generate` still needs a TTY this env lacks** — the Node migration folder was
hand-authored (runtime migrator only reads each folder's `migration.sql`, sorted by name; the
`snapshot.json` is solely for a future real-terminal `db:generate`). Same as the prior session.

---

## ⛔ Not started (supporting C, E) — follow-up PRs

Each is a multi-file, two-runtime effort. Keep parity (D1 ⇄ Drizzle + generated migration),
bump prompt versions on any prompt edit, add a changeset, and add cross-runtime conformance
assertions. **Do not land a shared behaviour into only one facade** (parity is a showstopper).

### C — tech-spec writer/reviewer pair (after the architect)

Mirror the spec-writer/spec-companion pattern. Captures architecture / tech-stack / cross-
cutting patterns (pagination, REST-vs-gRPC, libraries) so the Requirement Writer can ground
technical recommendations on `tech-spec/`.

- New kinds `tech-spec-writer` (container coding) + `tech-spec-companion` (companion,
  `targets: ['tech-spec-writer']` in `backend/packages/agents/src/agents/kinds/companions.ts`).
- `tech-spec-writer` system/user prompts (sibling of `SPEC_WRITER_SYSTEM_PROMPT` in
  `backend/packages/server/src/agents/ContainerAgentExecutor.ts`); **fragments-first guidance**
  (don't re-document team/org standards already in fragments — reference them); register a
  versioned prompt.
- `techSpecPostOp` in `backend/packages/agents/src/repo-ops/builtin.ts` (mirror `specPostOp`)
  rendering/committing a `tech-spec/` tree; add `techSpecDocSchema` + `coerceTechSpecDoc` to
  `backend/packages/contracts/src/`; register in `ExecutionService.BUILT_IN_POST_OPS`.
- New `tech-spec-aware` trait + guidance in `…/agents/kinds/traits.ts`; assign to architect,
  coder, reviewer.
- Insert `tech-spec-writer` then `tech-spec-companion` after `architect` in `seedPipelines`
  (`backend/packages/kernel/src/domain/seed.ts`); gates `false`/`false`.
- Frontend: palette/result view for `tech-spec-writer` (snapshot/catalog seam).

### E — web-search UI connection + Writer gateway access

Move Brave/SearXNG creds from env → a UI-managed connection (mirror `observability_connections`).

- New `web_search_connections` table: D1 migration + Drizzle schema/column + generated
  migration + both repos; cipher tag `cat-factory:web-search`; inject `webSearchSecretCipher`
  in both facades' `container.ts`.
- `WebSearchConnectionService` (integrations) + `WebSearchConnectionController`
  (`GET|PUT|DELETE /workspaces/:ws/web-search/connection`).
- Frontend `WebSearchConnectionPanel.vue` + `stores/webSearch.ts` (mirror
  `ObservabilityConnectionPanel.vue` / `stores/releaseHealth.ts`).
- Replace `createWebSearchUpstreamFromEnv` wiring with a per-workspace
  `ResolveWebSearchUpstream(workspaceId)` (load connection, decrypt, build
  Brave/SearXNG upstream); update `WebSearchProxyController` + remove the `WEB_SEARCH_*` env.
- **Wire the `webSearch` dep into `createRequirementsModule`** so the Requirement Writer's
  gateway-RAG path is live (the service + prompt builder already accept it; today only
  provider-hosted search is wired). Also add `requirement-writer` to the inline
  web-search allow-list (`DEFAULT_INLINE_WEB_SEARCH_KINDS`) if/when the Writer is ever routed
  through the inline executor.

### F — items 4 & 5

**Item 4 — business-only spec prompts (bump versions)**

- Extend `SPEC_WRITER_SYSTEM_PROMPT` + `specWriterUserPrompt` (`ContainerAgentExecutor.ts`):
  incorporate ONLY business requirements; for purely technical tasks "no new specs" is valid —
  return the baseline unchanged and emit `result.noBusinessSpecs: true` (add optional field to
  the spec result in `backend/packages/contracts/src/spec.ts`; `specPostOp` no-ops when set).
- Extend the spec-companion guidance (`backend/packages/agents/src/agents/prompts/companion.ts`,
  `spec-companion` branch): "no specs" is valid for technical tasks; corroborate or dispute,
  disputing via the existing companion loop. Add optional `technicalCorroborated: boolean` to
  `companionAssessmentSchema` (`backend/packages/contracts/src/companion.ts`), parsed in
  `CompanionController`.

**Item 5 — the `technical` label**

- Add `technical?: boolean` (default undefined) to `blockSchema`
  (`backend/packages/contracts/src/entities.ts`) + frontend mirror
  (`frontend/app/app/types/domain.ts`); persist (blocks-table column D1 ⇄ Drizzle + generated
  migration; update the shared block mapper in `backend/packages/server/src/persistence/mappers.ts`).
- Human authority: creation-modal checkbox + inspector tri-state toggle. A human-set value is
  NEVER overridden by the engine.
- Engine inference: in `ExecutionService.recordStepResult`, when `block.technical` is
  undefined and the spec-writer emitted `noBusinessSpecs` AND the spec-companion set
  `technicalCorroborated`, persist `block.technical = true` (symmetric `false` when specs were
  produced).
- Implementer awareness: thread `block.technical` through `AgentContextBuilder` into the build
  context; add conditional guidance to the build prompt template
  (`backend/packages/agents/scripts/precompile-prompts.mjs`, then regenerate
  `standard-templates.generated.ts`): when technical, the task definition / incorporated
  requirements are primary and specs are only a regression-spotting reference. Bump prompt
  versions.

### Tests still owed

- Cross-runtime conformance (`backend/internal/conformance`): a recommendation grounded on a
  repo file + an accepted recommendation folding into the next incorporation; the `technical`
  label human-override + engine-inference; a tech-spec post-op commit. Run against **both**
  Worker and Node harnesses.
- Logic unit tests in `requirements.logic.ts` for the recommendation lifecycle.

---

## How to verify what's landed

- Backend build: `pnpm -r --filter './backend/**' build` (green).
- Frontend typecheck: `cd frontend/app && pnpm typecheck` (green).
- Full backend suite (Postgres needed for the Node suite): `pnpm test:run` from the repo root.
  Note (CLAUDE.md): the Worker integration suite only runs cleanly on Linux/macOS; on Windows
  verify pure-logic changes from `backend/packages/orchestration`.
- Manual (local facade, `deploy/local`): start a task pipeline → in the requirements window,
  type an answer (auto-saves on blur), mark a finding "Recommend something" → "Request
  recommendations" → confirm the board shows a `Recommending…` spinner → review/accept a
  suggestion (note the "current standard" badge when it came from a fragment) → incorporate.

## Gotchas / notes for the next session

- `drizzle-kit generate` needs a TTY (fails in the sandboxed shell). The Node migration for
  the recommendations column was hand-authored (folder + `migration.sql` + `snapshot.json`
  with a fresh `id`, `prevIds` chained to the previous snapshot, the new column in `ddl`).
  Replicate that approach for future Node migrations here, or run `db:generate` from a real
  terminal.
- The Requirement Writer's `webSearch` (gateway-RAG) dep is intentionally left **unwired** in
  `createRequirementsModule` pending Workstream E — until then the Writer only gets
  provider-hosted web search on Anthropic/OpenAI models. The service + prompt already accept it.
- Pre-1.0: no back-compat shims. New columns default sensibly (`recommendations` → `'[]'`).
