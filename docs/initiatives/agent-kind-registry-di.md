# Slice: agent-kind registry → app-owned DI

**Status:** ✅ done · **Owner:** core · **Umbrella:**
[`registry-di-migration.md`](./registry-di-migration.md) (the "Agent kinds" row)

> This is the executable spec for ONE slice of the registry-DI initiative. Read the umbrella tracker
> first for the target pattern; this doc adds the agent-kind-specific call-site map, gotchas, and a
> resumable checklist. Update the checklist at the end of each PR.

## Why now (the trigger)

PR #783 (bug-triage phase F) went **CI-red on the Cloudflare worker shard only** — Node and local
passed. Root cause (reproduced locally, deterministic):

- The conformance suite's custom-agent / custom-gate `describe` blocks call
  `afterEach(() => clearRegisteredAgentKinds())`, which is `registry.clear()` on the **module-global**
  `Map` in `backend/packages/agents/src/agents/kinds/registry.ts`.
- `bug-investigator` (and the other built-ins `document` / `initiative`) are registered **only as a
  one-time import side-effect** of `@cat-factory/agents` and are never restored after a clear.
- On the **worker** the entire conformance suite runs in ONE module instance
  (`test/integration/conformance.spec.ts` → `defineConformanceSuite` → every `defineX`), so a later test
  (phase F, in `defineMiscConformance`) that needs `bug-investigator` finds it gone and its run fails.
  On **Node/local** each `defineX` is its own spec file (`conformance.misc.spec.ts`, …) with a fresh
  module → the pollution never surfaces. That asymmetry is the whole bug.

The gate block already half-knows this trap: it restores built-in **gates** with `registerBuiltinGates()`
after clearing. Nothing restores built-in **agent kinds**. Rather than add another restore band-aid, the
agreed fix is to remove the module-global entirely: an **app-owned `AgentKindRegistry` instance** built
fresh per app. No shared process state, no `clear*()`, and the external-adapter module-identity gotcha
goes away — exactly the initiative's goal.

Interim note: until this slice lands, the phase-F failure is a real red on #783's worker shard. A
one-line stopgap (re-register the built-ins after each `clearRegisteredAgentKinds()` in the two
conformance `afterEach` blocks, mirroring `registerBuiltinGates()`) would green CI without the
migration — **use it only if the branch must merge before this slice is done**; prefer landing the
migration.

## Target pattern

Mirror the backend-registries pilot (`RunnerBackendRegistry` / `EnvironmentBackendRegistry`,
`docs/initiatives/registry-di-migration.md` §"Target pattern"). One **adaptation**: the agent-kind
registry is owned by `@cat-factory/agents`, so it rides `CoreDependencies` as its **own field**
(`agentKindRegistry?: AgentKindRegistry`), NOT the integrations `BackendRegistries` bundle. Threading the
deep prompt-building reads is **option (a)**: add a `registry` parameter to the pure functions and pass it
from the services that already hold a constructor-injected deps bag. There is no existing carrier to
extend — `AgentRunContext` is a serialized kernel DTO, not a deps bag; do NOT put the registry on it.

## Work checklist

| #   | Item                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | File(s)                                                                                                                                                                                                                                                                       | Status  |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| 1   | `AgentKindRegistry` class (methods mirror today's accessors: `register`/`registerAll`/`get`/`all`/`requiresContainer`/`systemPrompt`/`userPrompt`/`webResearchHint`/`tuning`/`configContributions`/`agentStep`/`preOps`/`postOps`/`presentation`/`structuredOutput`) + `defaultAgentKindRegistry()` factory (pre-loads built-ins, NO module-load side effect). Keep `withDerivedOutput` private.                                                                                                          | `agents/src/agents/kinds/registry.ts`                                                                                                                                                                                                                                         | ✅ done |
| 2   | Built-in registrars take a registry param; delete the bottom-of-file side-effect calls                                                                                                                                                                                                                                                                                                                                                                                                                    | `agents/src/agents/kinds/{bug-investigator,document,initiative}.ts`                                                                                                                                                                                                           | ✅ done |
| 3   | Remove free `registerAgentKind(s)` / `registered*` / `clearRegisteredAgentKinds`; export `AgentKindRegistry` + `defaultAgentKindRegistry` + the param-taking registrars                                                                                                                                                                                                                                                                                                                                   | `agents/src/index.ts`, `registry.ts`                                                                                                                                                                                                                                          | ✅ done |
| 4   | Add optional `agentKindRegistry?: AgentKindRegistry` to `CoreDependencies`; default with `?? defaultAgentKindRegistry()` at the ExecutionService construction boundary                                                                                                                                                                                                                                                                                                                                    | `orchestration/src/container.ts`                                                                                                                                                                                                                                              | ✅ done |
| 5   | Thread `registry` param through the pure prompt fns: `systemPromptFor`/`userPromptFor` (covers private `applySurfaceDirectives`/`baseSystemPromptFor`), `traitsFor`/`traitGuidanceFor`/`hasTrait`, `agentTuningFor`, `configContributionsFor`/`configContributionCatalog`, `webResearchGuidanceFor`, `isInlineModelStep`                                                                                                                                                                                  | `agents/src/agents/catalog.ts`, `.../kinds/{traits,tuning,configs,step-surface}.ts`, `.../runtime/web-search.ts`                                                                                                                                                              | ✅ done |
| 6   | Source the instance from existing deps bags: `AiAgentExecutorDependencies`, `ContainerAgentExecutorDependencies` (→ `jobBody.ts` `buildKindBody`/`buildRegisteredAgentBody`/`buildMigratedBuiltInBody` + `prompts.ts` `onCallUserPrompt`), `ConsensusAgentExecutorDependencies`, `RunDispatcherDeps` (add one field), `ValidateRegistrationsOptions`                                                                                                                                                      | `agents/runtime/executor.ts`, `server/agents/{ContainerAgentExecutor,jobBody,prompts}.ts`, `consensus/ConsensusAgentExecutor.ts`, `orchestration/.../RunDispatcher.ts`, `orchestration/validation/validateRegistrations.ts`                                                   | ✅ done |
| 7   | Two bag-less sites: add a constructor/param — `CompositeAgentExecutor` (ctor currently `(inline, container)`) and sandbox `baselinePromptText`/`listBaselines`                                                                                                                                                                                                                                                                                                                                            | `server/agents/CompositeAgentExecutor.ts`, `sandbox/src/baselines.ts`                                                                                                                                                                                                         | ✅ done |
| 8   | `WorkspaceController`: read `container.agentKindRegistry` and pass into `snapshotCustomAgentKinds`/`snapshotAgentConfigCatalog`                                                                                                                                                                                                                                                                                                                                                                           | `server/src/modules/workspaces/WorkspaceController.ts`                                                                                                                                                                                                                        | ✅ done |
| 9   | Facade wiring (×3, keep runtimes symmetric): resolve `overrides.agentKindRegistry ?? defaultAgentKindRegistry()`, spread into `CoreDependencies` AND attach onto the `ServerContainer`; local shares the SAME instance into `buildNodeContainer`; update CF `validateRegistrationsOnce` to pass the registry                                                                                                                                                                                              | `runtimes/{cloudflare/src/infrastructure/container.ts,node/src/container.ts,local/src/container.ts}`                                                                                                                                                                          | ✅ done |
| 10  | Extension seam: the three `src/index.ts` re-export `registerAgentKind`/`clearRegisteredAgentKinds` today — replace with the DI seam (export `AgentKindRegistry`/`defaultAgentKindRegistry`; accept a pre-loaded registry through the existing container / `start()` / `startLocal()` injection, like the pilot lets a deployment register backends by reference). **Breaking.**                                                                                                                           | `runtimes/{cloudflare,node,local}/src/index.ts`                                                                                                                                                                                                                               | ✅ done |
| 11  | Conformance: add `agentKindRegistry?` to the `makeApp` options (mirror `backendRegistries`); each facade harness threads it into its container build; `FakeAgentExecutor` reads `registry.agentStep(kind)`; **delete both `afterEach(() => clearRegisteredAgentKinds())`** — custom-kind tests new-up `defaultAgentKindRegistry()`, register their kind by reference, and inject via `makeApp(opts, { agentKindRegistry })`. Add a cross-runtime "registered custom kind resolves identically" assertion. | `conformance/src/{harness,suite,FakeAgentExecutor}.ts`, each facade `test/harness.ts`/`helpers.ts` + CF `conformance.spec.ts`                                                                                                                                                 | ✅ done |
| 12  | Update direct-call tests to new-up a registry instead of global registration                                                                                                                                                                                                                                                                                                                                                                                                                              | `agents/.../kinds/{registry,tuning,step-surface,structured-output}.test.ts`, `orchestration/src/extension-registries.test.ts`, `orchestration/src/inline-web-search.test.ts`, `cloudflare/test/integration/composite-agent.spec.ts`, `example-custom-agent/src/index.test.ts` | ✅ done |
| 13  | Changeset (breaking removal of the free exports) + flip the umbrella tracker's "Agent kinds" row to ✅ done                                                                                                                                                                                                                                                                                                                                                                                               | `.changeset/*`, `docs/initiatives/registry-di-migration.md`                                                                                                                                                                                                                   | ✅ done |

## Also-pending (separate, small — the surviving #783 review finding)

Independent of the migration; can ship in the same PR or its own. `runExploreMode` gates the read-only
multi-repo fan-out on `if (job.peerRepos?.length && !job.persistentCheckout)`. The warm-pool transport
(`LocalContainerRunnerTransport.dispatchPooled`) injects `persistentCheckout: true` on **every** pooled
dispatch, so a `bug-investigator` run on a multi-service bug dispatched to a warm-pool member silently
falls through to the single-repo path and **drops the peer repos** — the cross-service investigation only
sees the primary repo, with no error. The coding path (`runCodingMode`) has no such guard and fans out
regardless (`runMultiRepoExplore`/`runMultiRepoCoding` both use an ephemeral `withWorkspace`, so the
persistent checkout is harmlessly ignored). Fix: drop `&& !job.persistentCheckout` from the explore guard
and update the stale "reused persistent checkout is single-repo" comment.

- File: `backend/internal/executor-harness/src/agent.ts` (`runExploreMode`, ~line 383).
- Status: **✅ done**. Dropped `&& !job.persistentCheckout` from the explore fan-out guard and
  updated the stale comment. Harness image stays `1.34.6` (already the branch's pending version —
  the phase-F changeset carries the `@cat-factory/executor-harness` patch this folds into); no new
  image bump, the three pins stay consistent.

## Conventions / gotchas carried in

- **`traitsFor → agentKindRegistry` edge.** `traits.ts` has its OWN separate registry (`traitRegistry` /
  `assignedTraits`, the "Agent traits" tracker row — NOT migrated here), but `traitsFor(kind)` reaches
  into the agent-kind registry via `registeredAgentKind(kind)?.traits`. So the agent-kind registry must be
  threaded into `traitsFor`/`traitGuidanceFor`/`hasTrait`, which are called by `catalog.ts:systemPromptFor`
  — the registry has to flow through that intra-package chain, not just from services.
- **Intra-package fan-out.** `systemPromptFor` → `applySurfaceDirectives` + `traitGuidanceFor` +
  `baseSystemPromptFor`→`registeredSystemPrompt`; `buildKindBody` → `buildRegisteredAgentBody`
  (default-arg `userPromptFor`) / `buildMigratedBuiltInBody`; `configContributionCatalog` →
  `configContributionsFor`. Each hop needs the param.
- **`example-custom-agent` is not wired by any shipped facade** (test + docs only), so no facade change for
  it; its own test moves to `register*(registry)`.
- **Keep the runtimes symmetric** — Worker + Node + local land together with the conformance assertion, or
  not at all (a facade-parity gap is a showstopper).
- **Pre-1.0 = no back-compat.** Remove the free functions outright; flag the extension-seam break in the
  changeset. Don't keep a shim.

## Verification

- Reproduce the flake first (baseline is red): `cd backend/runtimes/cloudflare && pnpm exec vitest run
test/integration/conformance.spec.ts` → currently 2 failed (phase F). After the slice → green **inside
  the full suite**, not just in isolation (`-t "phase F"` alone already passes today, which is the tell).
- `pnpm build:tsc`; `pnpm exec turbo run typecheck --filter=<each touched package>`; `pnpm test:run`.
- Guards: `pnpm lint:fix` (whole tree), `pnpm exec changeset status --since=origin/<base>`, `pnpm lint:knip`,
  `node scripts/check-package-catalog.mjs`.
- Push to the PR head branch `claude/bug-triaging-initiative-tif4vb`; confirm the worker shard goes green.
