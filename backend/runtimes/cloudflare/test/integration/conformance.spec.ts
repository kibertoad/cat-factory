import {
  AsyncFakeAgentExecutor,
  type ConformanceHarness,
  FakeAgentExecutor,
  FakeEnvConfigRepairer,
  FakeRepoBootstrapper,
  RecordingEventPublisher,
  defineConformanceSuite,
  makeIncorporatedClarityReview,
  makeIncorporatedReview,
  makeOnboardingProbe,
  makeReadyReviewWithOpenItem,
} from '@cat-factory/conformance'
import { env } from 'cloudflare:test'
import { makeApp, fragmentLibraryDeps, tasksDeps } from '../helpers'
import { FakeTaskSourceProvider } from '../fakes/FakeTaskSourceProvider'
import { buildContainer } from '../../src/infrastructure/container'
import { D1RequirementReviewRepository } from '../../src/infrastructure/repositories/D1RequirementReviewRepository'
import { D1ClarityReviewRepository } from '../../src/infrastructure/repositories/D1ClarityReviewRepository'

// Run the shared cross-runtime conformance suite against the Cloudflare Worker
// facade (the real Hono app over a real local D1, inside workerd). The Node
// facade runs the identical suite over real Postgres — together they mandate
// feature parity: a behavioural difference fails the same assertion in one runtime.

const harness: ConformanceHarness = {
  name: 'cloudflare',
  makeApp: (agentOptions, opts) => {
    // Record emitted run snapshots (shared by the start-time container and drive's
    // own container, since it rides the core overrides) so the suite can assert
    // intermediate transitions. Confined to the conformance adapter so the shared
    // `makeApp`/`TestApp` other worker tests use is untouched.
    const recorder = new RecordingEventPublisher()
    const app = makeApp(
      agentOptions?.asyncKinds?.length
        ? new AsyncFakeAgentExecutor(agentOptions)
        : new FakeAgentExecutor(agentOptions),
      // A deterministic bootstrapper so the shared suite can drive the bootstrap
      // lifecycle against D1 without a real container (driven via driveBootstrap); the
      // prompt-fragment library repos (deterministic selector) so the library CRUD
      // assertion runs against D1 too — parity with the Node/local fragment wiring.
      {
        executionEventPublisher: recorder,
        repoBootstrapper: new FakeRepoBootstrapper(),
        // A deterministic env-config-repairer so the shared suite can drive the repair
        // dispatch→poll→re-validate lifecycle against D1 without a real container (driven via
        // driveEnvConfigRepair); the module only builds when an env provider is also wired.
        envConfigRepairer: new FakeEnvConfigRepairer(),
        // Inject the engine's run-repo resolver (a fake in the suite) so a registered
        // custom kind's pre/post-op hooks run + commit identically to a real GitHub-wired facade.
        ...(opts?.resolveRunRepoContext
          ? { resolveRunRepoContext: opts.resolveRunRepoContext }
          : {}),
        // Inject a native environment provider + the block-less coords resolver (both
        // fakes in the suite) so the on-demand repo-config validate route is asserted
        // end-to-end against real D1, identically to Node.
        ...(opts?.environmentProvider ? { environmentProvider: opts.environmentProvider } : {}),
        ...(opts?.resolveRepoFilesForCoords
          ? { resolveRepoFilesForCoords: opts.resolveRepoFilesForCoords }
          : {}),
        ...fragmentLibraryDeps(),
        // A deterministic task source (fake 'jira') over the real D1 task repos, so the
        // shared suite can assert create-task-from-issue parity against D1 too.
        ...tasksDeps({
          providers: [new FakeTaskSourceProvider('jira'), new FakeTaskSourceProvider('linear')],
        }),
      },
      // The Worker binds `AI` in tests; let the suite force the opt-in flag off so the
      // provider-key assertions behave identically to Node (which has no binding).
      // `gateProviders` is re-wired on every per-request container rebuild, so a faked CI
      // status provider survives the build's `clearGateProviders()` reset.
      {
        cloudflareModelsEnabled: opts?.cloudflareModelsEnabled,
        gateProviders: opts?.gateProviders,
      },
    )
    return {
      ...app,
      executionEmits: (blockId) =>
        blockId ? recorder.emits.filter((e) => e.blockId === blockId) : recorder.emits,
      boardEmits: (blockId) =>
        blockId ? recorder.boardEvents.filter((e) => e.blockId === blockId) : recorder.boardEvents,
      seedIncorporatedReview: (workspaceId, blockId, requirements) =>
        new D1RequirementReviewRepository({ db: env.DB }).upsert(
          workspaceId,
          makeIncorporatedReview(blockId, requirements),
        ),
      seedReadyReview: (workspaceId, blockId) =>
        new D1RequirementReviewRepository({ db: env.DB }).upsert(
          workspaceId,
          makeReadyReviewWithOpenItem(blockId),
        ),
      seedIncorporatedClarityReview: (workspaceId, blockId, report) =>
        new D1ClarityReviewRepository({ db: env.DB }).upsert(
          workspaceId,
          makeIncorporatedClarityReview(blockId, report),
        ),
      localModelEndpoints: () => {
        const svc = buildContainer(env, {
          agentExecutor: new FakeAgentExecutor(),
        }).localModelEndpoints
        if (!svc) return undefined
        return {
          list: (userId: string) => svc.list(userId),
          upsert: (userId: string, input) => svc.upsert(userId, input as never),
          resolve: (userId: string, provider: string) => svc.resolve(userId, provider),
          remove: (userId: string, provider: string) => svc.remove(userId, provider as never),
        }
      },
      openRouterCatalog: () => {
        const svc = buildContainer(env, {
          agentExecutor: new FakeAgentExecutor(),
        }).openRouterCatalog
        if (!svc) return undefined
        return {
          get: (workspaceId: string) => svc.get(workspaceId),
          upsert: (workspaceId: string, input) => svc.upsert(workspaceId, input),
        }
      },
      userSecrets: () => {
        const svc = buildContainer(env, {
          agentExecutor: new FakeAgentExecutor(),
        }).userSecrets
        if (!svc) return undefined
        return {
          store: (userId, kind, input) => svc.store(userId, kind as never, input),
          resolve: (userId, kind) => svc.resolve(userId, kind as never),
          describe: (kind) => svc.describe(kind as never),
        }
      },
      // The identity/onboarding services over the same local D1 (invitations are always
      // wired in the worker; email senders stay opt-in and out of the probe). A fake
      // executor override skips the strict container-executor selection (the identity
      // layer never touches the agent runner).
      onboarding: () =>
        makeOnboardingProbe(buildContainer(env, { agentExecutor: new FakeAgentExecutor() })),
    }
  },
}

defineConformanceSuite(harness)
