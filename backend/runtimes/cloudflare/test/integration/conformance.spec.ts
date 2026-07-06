import {
  AsyncFakeAgentExecutor,
  type ConformanceHarness,
  FakeAgentExecutor,
  FakeEnvConfigRepairer,
  FakeRepoBootstrapper,
  RecordingEventPublisher,
  defineCacheSuite,
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
import { D1ServiceRepository } from '../../src/infrastructure/repositories/D1ServiceRepository'
import { D1BlockRepository } from '../../src/infrastructure/repositories/D1BlockRepository'
import { D1NotificationRepository } from '../../src/infrastructure/repositories/D1NotificationRepository'
import { D1DocumentRepository } from '../../src/infrastructure/repositories/D1DocumentRepository'
import { D1DocInterviewRepository } from '../../src/infrastructure/repositories/D1DocInterviewRepository'

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
    // The custom-kind suite injects a pre-loaded registry: thread it into BOTH the fake
    // (so it detects the custom kind's structured output) and the container overrides below.
    const fakeOptions = {
      ...agentOptions,
      ...(opts?.agentKindRegistry ? { agentKindRegistry: opts.agentKindRegistry } : {}),
    }
    const app = makeApp(
      agentOptions?.asyncKinds?.length
        ? new AsyncFakeAgentExecutor(fakeOptions)
        : new FakeAgentExecutor(fakeOptions),
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
        // Inject the binary-artifact store resolver so the suite drives the start-time
        // binary-storage gate deterministically (the Worker binds R2 by default, so a null
        // resolver is the only way to assert the unconfigured-refusal path on this runtime).
        ...(opts?.resolveBinaryArtifactStore
          ? { resolveBinaryArtifactStore: opts.resolveBinaryArtifactStore }
          : {}),
        // Inject a native environment provider + the block-less coords resolver (both
        // fakes in the suite) so the on-demand repo-config validate route is asserted
        // end-to-end against real D1, identically to Node.
        ...(opts?.environmentProvider ? { environmentProvider: opts.environmentProvider } : {}),
        ...(opts?.resolveRepoFilesForCoords
          ? { resolveRepoFilesForCoords: opts.resolveRepoFilesForCoords }
          : {}),
        // Inject the deployment-level detection-convention extensions (a fake in the suite) so
        // convention-honouring service-provisioning detection is asserted against real D1,
        // identically to Node — catching a facade that forgot the config→deps threading.
        ...(opts?.detectionConventions ? { detectionConventions: opts.detectionConventions } : {}),
        // Inject the test quality-control companion's inline reviewer (a fake in the suite) so the
        // full QC loop is driven against real D1 without a model, identically to Node.
        ...(opts?.testerQualityReviewer
          ? { testerQualityReviewer: opts.testerQualityReviewer }
          : {}),
        // Inject the async deploy lifecycle (a fake deploy-job client + clone-target resolver) so
        // the suite drives the container render path through this facade's wiring, identically to
        // Node — asserting the `deploy` dispatch is accepted and the stubbed view finalizes the same.
        ...(opts?.deployJobClient ? { deployJobClient: opts.deployJobClient } : {}),
        ...(opts?.resolveDeployCloneTarget
          ? { resolveDeployCloneTarget: opts.resolveDeployCloneTarget }
          : {}),
        // Inject the app-owned backend registries (pre-loaded with custom kinds in the
        // custom-backend suite) via the CoreDependencies overrides the Worker build reads, so a
        // registered custom backend is resolved by reference, exactly like a real deployment.
        ...(opts?.backendRegistries
          ? {
              environmentBackendRegistry: opts.backendRegistries.environmentBackendRegistry,
              runnerBackendRegistry: opts.backendRegistries.runnerBackendRegistry,
              customManifestTypeRegistry: opts.backendRegistries.customManifestTypeRegistry,
              userSecretKindRegistry: opts.backendRegistries.userSecretKindRegistry,
            }
          : {}),
        // Inject the app-owned agent-kind registry (pre-loaded with a custom kind in the
        // custom-kind suite) via the CoreDependencies overrides the Worker build reads, so the
        // container resolves it by reference — the SAME instance the fake executor above got.
        ...(opts?.agentKindRegistry ? { agentKindRegistry: opts.agentKindRegistry } : {}),
        ...fragmentLibraryDeps(),
        // A deterministic task source (fake 'jira') over the real D1 task repos, so the
        // shared suite can assert create-task-from-issue parity against D1 too. The suite may
        // override with pre-seeded providers to drive the recurring `bug-intake` step.
        ...tasksDeps({
          providers: opts?.taskSourceProviders ?? [
            new FakeTaskSourceProvider('jira'),
            new FakeTaskSourceProvider('linear'),
          ],
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
      seedService: (service) => new D1ServiceRepository({ db: env.DB }).insert(service),
      getService: (id) => new D1ServiceRepository({ db: env.DB }).get(id),
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
          // Thread the injected app-owned secret-kind registry (custom kinds pre-registered by
          // the suite) so the probe's service describes them by reference, like the main build.
          ...(opts?.backendRegistries
            ? { userSecretKindRegistry: opts.backendRegistries.userSecretKindRegistry }
            : {}),
        }).userSecrets
        if (!svc) return undefined
        return {
          store: (userId, kind, input) => svc.store(userId, kind as never, input),
          resolve: (userId, kind) => svc.resolve(userId, kind as never),
          describe: (kind) => svc.describe(kind as never),
        }
      },
      packageRegistries: () => {
        const svc = buildContainer(env, { agentExecutor: new FakeAgentExecutor() })
          .packageRegistries?.service
        if (!svc) return undefined
        return {
          resolveForDispatch: (workspaceId: string) => svc.resolveForDispatch(workspaceId),
        }
      },
      userSettings: () => {
        const svc = buildContainer(env, { agentExecutor: new FakeAgentExecutor() }).userSettings
          ?.service
        if (!svc) return undefined
        return {
          get: (userId) => svc.get(userId),
          update: (userId, input) => svc.update(userId, input),
        }
      },
      // The identity/onboarding services over the same local D1 (invitations are always
      // wired in the worker; email senders stay opt-in and out of the probe). A fake
      // executor override skips the strict container-executor selection (the identity
      // layer never touches the agent runner).
      onboarding: () =>
        makeOnboardingProbe(buildContainer(env, { agentExecutor: new FakeAgentExecutor() })),
      executionRepository: () =>
        buildContainer(env, { agentExecutor: new FakeAgentExecutor() }).executionRepository,
      agentRunRepository: () =>
        buildContainer(env, { agentExecutor: new FakeAgentExecutor() }).agentRunRepository,
      blockRepository: () => new D1BlockRepository({ db: env.DB }),
      notificationRepository: () => new D1NotificationRepository({ db: env.DB }),
      documentRepository: () => new D1DocumentRepository({ db: env.DB }),
      docInterviewRepository: () => new D1DocInterviewRepository({ db: env.DB }),
    }
  },
}

defineConformanceSuite(harness)
// Caching initiative: the Worker serves the fragment catalog through the
// ISOLATE-SAFE (pass-through) profile — coherence must hold there exactly as it
// does through Node's live in-memory cache.
defineCacheSuite(harness)
