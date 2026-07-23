import {
  AsyncFakeAgentExecutor,
  type ConformanceHarness,
  FakeAgentExecutor,
  FakeEnvConfigRepairer,
  FakeRepoBootstrapper,
  RecordingEventPublisher,
  defineCacheSuite,
  defineConformanceSuite,
  defineWorkspaceAccessSuite,
  defineWorkspaceRbacSuite,
  makeIncorporatedClarityReview,
  makeIncorporatedReview,
  makeOnboardingProbe,
  makeReadyReviewWithOpenItem,
  mintSession,
} from '@cat-factory/conformance'
import { env } from 'cloudflare:test'
import { makeApp, fragmentLibraryDeps, tasksDeps } from '../helpers'
import { FakeTaskSourceProvider } from '../fakes/FakeTaskSourceProvider'
import { buildContainer } from '../../src/infrastructure/container'
import { D1RequirementReviewRepository } from '../../src/infrastructure/repositories/D1RequirementReviewRepository'
import { D1ClarityReviewRepository } from '../../src/infrastructure/repositories/D1ClarityReviewRepository'
import { D1ServiceRepository } from '../../src/infrastructure/repositories/D1ServiceRepository'
import { D1BlockRepository } from '../../src/infrastructure/repositories/D1BlockRepository'
import { D1WorkspaceRepository } from '../../src/infrastructure/repositories/D1WorkspaceRepository'
import { D1WorkspaceMemberRepository } from '../../src/infrastructure/repositories/D1WorkspaceMemberRepository'
import { D1InitiativeRepository } from '../../src/infrastructure/repositories/D1InitiativeRepository'
import { D1NotificationRepository } from '../../src/infrastructure/repositories/D1NotificationRepository'
import { D1DocumentRepository } from '../../src/infrastructure/repositories/D1DocumentRepository'
import { D1DocInterviewRepository } from '../../src/infrastructure/repositories/D1DocInterviewRepository'
import { D1TaskRepository } from '../../src/infrastructure/repositories/D1TaskRepository'

// Run the shared cross-runtime conformance suite against the Cloudflare Worker
// facade (the real Hono app over a real local D1, inside workerd). The Node
// facade runs the identical suite over real Postgres — together they mandate
// feature parity: a behavioural difference fails the same assertion in one runtime.

type WorkerMakeAppOpts = Parameters<ConformanceHarness['makeApp']>[1]

/** Copy only the truthy-valued keys of `obj` — the object-literal form of `...(v ? { k: v } : {})`. */
function onlyTruthy<T extends object>(obj: T): Partial<T> {
  const out: Partial<T> = {}
  for (const key of Object.keys(obj) as (keyof T)[]) {
    if (obj[key]) out[key] = obj[key]
  }
  return out
}

// The core-dependency overrides the Worker build reads, split out of the harness `makeApp` to
// keep it within the complexity budget. Behaviour-neutral: each optional override still lands
// only when the suite supplies it (the `onlyTruthy` filter mirrors the prior `...(v ? {} : {})`).
function buildWorkerConformanceDeps(recorder: RecordingEventPublisher, opts: WorkerMakeAppOpts) {
  const o = opts ?? {}
  // Inject the app-owned backend registries (pre-loaded with custom kinds in the custom-backend
  // suite) via the CoreDependencies overrides the Worker build reads, so a registered custom
  // backend is resolved by reference, exactly like a real deployment.
  const backendRegistries = o.backendRegistries
    ? {
        environmentBackendRegistry: o.backendRegistries.environmentBackendRegistry,
        runnerBackendRegistry: o.backendRegistries.runnerBackendRegistry,
        customManifestTypeRegistry: o.backendRegistries.customManifestTypeRegistry,
        userSecretKindRegistry: o.backendRegistries.userSecretKindRegistry,
      }
    : {}
  return {
    // A deterministic bootstrapper so the shared suite can drive the bootstrap lifecycle against
    // D1 without a real container (driven via driveBootstrap); the prompt-fragment library repos
    // (deterministic selector) so the library CRUD assertion runs against D1 too — parity with
    // the Node/local fragment wiring.
    executionEventPublisher: recorder,
    repoBootstrapper: new FakeRepoBootstrapper(),
    // A deterministic env-config-repairer so the shared suite can drive the repair
    // dispatch→poll→re-validate lifecycle against D1 without a real container (driven via
    // driveEnvConfigRepair); the module only builds when an env provider is also wired.
    envConfigRepairer: new FakeEnvConfigRepairer(),
    // Each override below lands only when the suite supplies it:
    // - resolveRunRepoContext: the engine's run-repo resolver (a fake) so a registered custom
    //   kind's pre/post-op hooks run + commit identically to a real GitHub-wired facade.
    // - resolveBinaryArtifactStore: the Worker binds R2 by default, so a null resolver is the
    //   only way to assert the unconfigured-refusal path on this runtime.
    // - environmentProvider + resolveRepoFilesForCoords: a native env provider + block-less
    //   coords resolver so the on-demand repo-config validate route is asserted against real D1.
    // - detectionConventions: deployment-level detection-convention extensions asserted against D1.
    // - testerQualityReviewer: the QC companion's inline reviewer so the full QC loop drives on D1.
    // - deployJobClient + resolveDeployCloneTarget: the async deploy lifecycle so the container
    //   render path is driven through this facade's wiring.
    // - agentKindRegistry: the app-owned registry (a custom kind pre-registered) resolved by
    //   reference — the SAME instance the fake executor above got — plus the gate/step/preset/
    //   task-type registries the matching suites pre-load.
    ...onlyTruthy({
      resolveRunRepoContext: o.resolveRunRepoContext,
      resolveBinaryArtifactStore: o.resolveBinaryArtifactStore,
      environmentProvider: o.environmentProvider,
      resolveRepoFilesForCoords: o.resolveRepoFilesForCoords,
      detectionConventions: o.detectionConventions,
      testerQualityReviewer: o.testerQualityReviewer,
      deployJobClient: o.deployJobClient,
      resolveDeployCloneTarget: o.resolveDeployCloneTarget,
      agentKindRegistry: o.agentKindRegistry,
      gateRegistry: o.gateRegistry,
      stepResolverRegistry: o.stepResolverRegistry,
      initiativePresetRegistry: o.initiativePresetRegistry,
      taskTypeRegistry: o.taskTypeRegistry,
    }),
    ...backendRegistries,
    ...fragmentLibraryDeps(),
    // A deterministic task source (fake 'jira') over the real D1 task repos, so the shared suite
    // can assert create-task-from-issue parity against D1 too. The suite may override with
    // pre-seeded providers to drive the recurring `bug-intake` step.
    ...tasksDeps({
      providers: o.taskSourceProviders ?? [
        new FakeTaskSourceProvider('jira'),
        new FakeTaskSourceProvider('linear'),
      ],
    }),
  }
}

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
      buildWorkerConformanceDeps(recorder, opts),
      // The Worker binds `AI` in tests; let the suite force the opt-in flag off so the
      // provider-key assertions behave identically to Node (which has no binding).
      // `gateProviders` is applied onto each build's app-owned `providerRegistry` (fresh per
      // per-request container rebuild), so a faked CI status provider is wired on every rebuild.
      {
        cloudflareModelsEnabled: opts?.cloudflareModelsEnabled,
        gateProviders: opts?.gateProviders,
      },
    )
    const sessionSecret = (env as { AUTH_SESSION_SECRET?: string }).AUTH_SESSION_SECRET ?? ''
    return {
      ...app,
      authEnabled: Boolean(sessionSecret),
      session: (user) => mintSession(sessionSecret, user),
      createWorkspaceInAccount: (accountId, ownerUserId, options) =>
        buildContainer(env, { agentExecutor: new FakeAgentExecutor() }).workspaceService.create(
          { name: options?.name ?? 'RBAC board', seed: options?.seed ?? false },
          ownerUserId,
          accountId,
        ),
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
      workspaceRepository: () => new D1WorkspaceRepository({ db: env.DB }),
      workspaceMemberRepository: () => new D1WorkspaceMemberRepository({ db: env.DB }),
      initiativeRepository: () => new D1InitiativeRepository({ db: env.DB }),
      notificationRepository: () => new D1NotificationRepository({ db: env.DB }),
      documentRepository: () => new D1DocumentRepository({ db: env.DB }),
      taskRepository: () => new D1TaskRepository({ db: env.DB }),
      docInterviewRepository: () => new D1DocInterviewRepository({ db: env.DB }),
    }
  },
}

defineConformanceSuite(harness)
// Workspace-RBAC initiative (slice 2): the membership roster + access-mode persistence
// must round-trip identically on D1 and Postgres.
defineWorkspaceAccessSuite(harness)
// Workspace-RBAC initiative (slice 3): the gate's resolution + viewer write floor + list
// filtering, enforced over the real HTTP gate — identically on D1 and Postgres.
defineWorkspaceRbacSuite(harness)
// Caching initiative: the Worker serves the fragment catalog through the
// ISOLATE-SAFE (pass-through) profile — coherence must hold there exactly as it
// does through Node's live in-memory cache.
defineCacheSuite(harness)
