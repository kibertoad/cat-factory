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

| #   | Target                                                                                   |    Lines | Extraction                                                                                                                                                                                                                                                              | Risk                                            | Status         |
| --- | ---------------------------------------------------------------------------------------- | -------: | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- | -------------- |
| 1   | `backend/packages/server/src/agents/ContainerAgentExecutor.ts`                           |     1956 | **Result coercion** (`toRunResult` + `prNumberFromUrl`/`clamp01`/`coerceRationale`/`coerceMergeAssessment`/`coerceOnCallAssessment`/`coerceTestReport`) → `containerAgentResult.ts` (+ `test/containerAgentResult.spec.ts`)                                             | very low (pure fns)                             | ✅ done        |
| 2   | same                                                                                     |          | **Prompt material**: system-prompt constants + shape hints + user-prompt builders (`blueprintUserPrompt`/`specWriterUserPrompt`/`mergerUserPrompt`/`onCallUserPrompt`/`testerInfraSpec`/`prBody`) → `prompts.ts`                                                        | very low (pure)                                 | ✅ done        |
| 3   | same                                                                                     |          | **Per-kind job-body builders** (`buildKindBody`/`buildRegisteredAgentBody`/`buildMigratedBuiltInBody`) → `jobBody.ts`                                                                                                                                                   | low–med (uses `parts`+context, no `this` state) | ✅ done        |
| 4   | `runtimes/cloudflare/src/infrastructure/container.ts` + `runtimes/node/src/container.ts` | ~2100 ea | Group the `select*`/`build*` wiring blocks (model providers, GitHub, merge/notifications, content sources, infrastructure) into per-concern `wire*.ts` helpers **per facade** — keep runtimes symmetric. Worked as concern sub-slices (4a–4e), one per pass — see below | medium                                          | 🔄 in-progress |
| 5   | `backend/packages/orchestration/src/container.ts`                                        |     2055 | Split the ~24 `createXModule()` assemblers into a few `coreModules-*.ts` files; `createCore()` stays the hub                                                                                                                                                            | low–med                                         | ☐ todo         |

### Split #4 sub-slices (one concern group per pass, symmetric across both facades)

Each facade groups its OWN wiring (D1 vs Drizzle), so "symmetric" here means the SAME
concern is extracted from both `container.ts` files in the same pass, into equivalently
named `wire*.ts` helpers. The extracted functions keep identical signatures/bodies (pure
move) and are re-imported at their original call sites.

| #   | Concern group                                                                                                                  | Extraction                                                                                                                                                                                                                                               | Status  |
| --- | ------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| 4a  | Credential / subscription / provider-key services (the ENCRYPTION_KEY-sealed per-scope stores)                                 | `wireCredentialServices.ts` per facade — `build{Subscription,ApiKey,PublicApiKey,PersonalSubscription,LocalModelEndpoint,UserSecret,OpenRouterCatalog}Service` (+ `buildResolveUserGitHubToken` on the Worker; Node mirrors the 7 `buildNode*` builders) | ✅ done |
| 4b  | Model providers (resolver + workspace-default + langfuse sink + web-search upstream)                                           | `wireModelProviders.ts` per facade                                                                                                                                                                                                                       | ☐ todo  |
| 4c  | GitHub core (App registry, repo-target resolvers, engine VCS client, `selectGitHubDeps`)                                       | `wireGitHub.ts` per facade                                                                                                                                                                                                                               | ☐ todo  |
| 4d  | Merge / notifications (merge-lifecycle, Slack, email, release-health, incident enrichment)                                     | `wireMergeNotifications.ts` per facade                                                                                                                                                                                                                   | ☐ todo  |
| 4e  | Content sources + infrastructure (documents/tasks/recurring; transport, runners, environments, deploy, bootstrapper, executor) | `wireContentSources.ts` / `wireInfrastructure.ts` per facade                                                                                                                                                                                             | ☐ todo  |

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
- Split #2 (prompt material): moved the per-kind prompt material — the
  blueprint/spec-writer/merger/on-call system prompts, the structured-output shape hints, and
  the `blueprintUserPrompt`/`specWriterUserPrompt`/`mergerUserPrompt`/`onCallUserPrompt`/
  `testerInfraSpec`/`prBody` builders — out of `ContainerAgentExecutor.ts` into `prompts.ts`,
  re-imported at their original call sites; added `test/prompts.spec.ts` characterisation
  tests. Pure move, no behaviour change. (The `blueprints`/`spec-writer` prompts + builders have
  since moved on again — down into `@cat-factory/agents`'
  `agents/kinds/spec-blueprints.ts` — as those two kinds were migrated onto the
  `registerAgentKind` seam; see `docs/refactoring-candidates.md` #5.)
- Split #4a (container credential-service wiring): moved the sealed per-scope credential /
  subscription / provider-key service builders out of BOTH facades' `container.ts` into a new
  per-facade `wireCredentialServices.ts` — the Worker's `buildSubscriptionService` /
  `buildApiKeyService` / `buildPublicApiKeyService` / `buildPersonalSubscriptionService` /
  `buildLocalModelEndpointService` / `buildUserSecretService` / `buildResolveUserGitHubToken` /
  `buildOpenRouterCatalogService`, and the Node facade's seven `buildNode*` mirrors — re-imported
  at their original call sites. Each builder keeps its exact signature + body (pure move); the
  now-unused imports were pruned from each `container.ts`. Symmetric across runtimes, first
  sub-slice of split #4, establishing the `wire*.ts` target pattern. Verified: `typecheck` + full
  dependency `build` green on `@cat-factory/worker` + `@cat-factory/node-server`, `knip`/`oxlint`
  clean, and the Node container-wiring conformance specs (`conformance.core`, `container-execution`,
  `auth-gate`, `config`) green against real Postgres. No behaviour change.
- Split #3 (per-kind job-body builders): moved the three per-kind harness job-body builders —
  `buildKindBody` (the kind dispatch ladder), `buildRegisteredAgentBody` (the generic
  `agent`-surface body) and `buildMigratedBuiltInBody` (the Task-5 migrated built-ins) — out of
  `ContainerAgentExecutor.ts` into `jobBody.ts` as free functions taking a shared `KindBodyParts`,
  re-imported at the single `buildJobBody` call site. They never touched `this`/instance state, so
  the move is mechanical. The existing `test/containerAgentJobBody.spec.ts` snapshots (driven through
  the public `startJob`) stay byte-identical — the diff-the-bodies guard. Pure move, no behaviour change.
