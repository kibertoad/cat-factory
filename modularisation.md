# Modularisation tracker

A living backlog for splitting oversized files into cohesive units. This is **ongoing**
hygiene work, executed one split per pass so each change stays small and reviewable.

## Ground rule — no functionality may be removed or altered

Every split is a **pure move**: the exact same code relocated to a new file and
re-imported at its original call site. Behaviour, public API, types, and wiring stay
**identical** — only file boundaries change. A split is never the place to "also fix"
something. If a move tempts a behaviour change, do it in a separate, clearly-labelled
commit. Each split must keep `typecheck` / `test:run` / `build` green with no test edits
beyond adding new co-located tests for the extracted unit.

## Conventions (mirror what the repo already does)

- Pure logic → co-located `*.logic.ts` with a sibling `*.logic.test.ts` /`*.test.ts`
  (see `backend/packages/orchestration/src/modules/execution/`).
- Stateful sub-areas → dedicated `*Controller.ts` / `*.ts` collaborators injected into
  the parent service.
- Frontend → composables under `frontend/app/app/composables/`, child `.vue` components,
  helpers under `frontend/app/app/utils/`.
- Any change to a versioned package needs a changeset.
- Shared `@cat-factory/server` changes are runtime-neutral; facade-specific changes must
  stay symmetric across `runtimes/cloudflare` ⇄ `runtimes/node` (see CLAUDE.md).

## Scope: Backend DI / executor

| #   | Target                                                                                   |    Lines | Extraction                                                                                                                                                                                                             | Risk                                            | Status  |
| --- | ---------------------------------------------------------------------------------------- | -------: | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- | ------- |
| 1   | `backend/packages/server/src/agents/ContainerAgentExecutor.ts`                           |     1956 | **Result coercion** (`toRunResult` + `prNumberFromUrl`/`clamp01`/`coerceRationale`/`coerceMergeAssessment`/`coerceOnCallAssessment`/`coerceTestReport`) → `containerAgentResult.ts` (+ `test/containerAgentResult.spec.ts`) | very low (pure fns)                             | ✅ done |
| 2   | same                                                                                     |          | **Prompt material**: system-prompt constants + shape hints + user-prompt builders (`blueprintUserPrompt`/`specWriterUserPrompt`/`mergerUserPrompt`/`onCallUserPrompt`/`testerInfraSpec`/`prBody`) → `prompts.ts`       | very low (pure)                                 | ☐ todo  |
| 3   | same                                                                                     |          | **Per-kind job-body builders** (`buildKindBody`/`buildRegisteredAgentBody`/`buildMigratedBuiltInBody`) → `jobBody.ts`                                                                                                  | low–med (uses `parts`+context, no `this` state) | ☐ todo  |
| 4   | `runtimes/cloudflare/src/infrastructure/container.ts` + `runtimes/node/src/container.ts` | ~2100 ea | Group the `select*`/`build*` wiring blocks (model providers, GitHub, merge/notifications, content sources, infrastructure) into per-concern `wire*.ts` helpers **per facade** — keep runtimes symmetric                | medium                                          | ☐ todo  |
| 5   | `backend/packages/orchestration/src/container.ts`                                        |     2055 | Split the ~24 `createXModule()` assemblers into a few `coreModules-*.ts` files; `createCore()` stays the hub                                                                                                           | low–med                                         | ☐ todo  |

## Other areas (out of scope this pass — recorded so they aren't lost)

These came out of the same analysis but are deferred until the DI/executor backlog
above is worked down.

### Backend — orchestration execution engine

- `ExecutionService.ts` (2471) → extract pre-flight validation, gate-decision handling,
  merge finalization, review-kind builders into collaborators (the `start`/`advance`/
  `step` spine stays on the service).
- `RunDispatcher.ts` (2545) → extract the gate-evaluation engine, the follow-up companion
  loop, and repo pre/post-op coordination into dedicated files.
- `AgentContextBuilder.ts` (583) → fragment resolution + review-document lookups +
  service-config resolution into focused resolvers.

### Frontend — large components / stores

- `RequirementsReviewWindow.vue` (978), `PipelineBuilder.vue` (890), `AddTaskModal.vue`
  (818), `TestReportWindow.vue` (799), `AgentStepDetail.vue` (796) → extract composables
  and child components per cohesive section.
- `stores/ui.ts` (781) → split modal state / result-view routing / AI-onboarding /
  integration-hub navigation into focused stores or composables.

## Log

- Split #1 (result coercion): moved the runner-output → engine-result normalisation out of
  `ContainerAgentExecutor.ts` into `containerAgentResult.ts`; added
  `test/containerAgentResult.spec.ts` characterisation tests. Pure move, no behaviour change.
