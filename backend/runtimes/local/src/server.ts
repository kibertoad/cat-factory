import { execFile } from 'node:child_process'
import { isDeepStrictEqual, promisify } from 'node:util'
import type { serve } from '@hono/node-server'
import {
  type AgentKindRegistry,
  type BinaryGeneratorRegistry,
  type InitiativePresetRegistry,
  type FoundationalServiceRegistry,
  type TaskTypeRegistry,
  DEFAULT_APP_CACHES_PROFILE,
  NodeRealtimeHub,
  backfillDeclaredSeeds,
  createApp,
  installProcessFailureGuards,
  serveAppWithRealtime,
  serveMisconfigured,
  start,
  startBootClock,
  startOtelLogExport,
} from '@cat-factory/node-server'
import {
  DOCS,
  ENV_VARS_ANCHORS,
  isConfigValidationError,
  logger,
  parseLogLevel,
  setLogLevel,
} from '@cat-factory/server'
import {
  runBestEffort,
  type BinaryStoreRegistry,
  type CreateSharedStackInput,
  type GateRegistry,
  type JudgeRegistry,
  type PipelineRegistry,
  type PromptFragmentRegistry,
  type StepResolverRegistry,
  type ToolSecretResolver,
  type VcsProviderRegistry,
} from '@cat-factory/kernel'
import { type RegistrationProblem, validateRegistrationsOnce } from '@cat-factory/orchestration'
import { FRAGMENTS_BY_ID } from '@cat-factory/prompt-fragments'
import type { BackendRegistries, RegisterHandlerInput } from '@cat-factory/integrations'
import { applyLocalDefaults, withLocalEnvCliAdvice } from './config.js'
import { buildLocalContainer } from './container.js'
import { githubPatCreationUrl, warnOnGitHubPatProblemInBackground } from './github.js'
import { createLocalVcsCredentialSource } from './vcsCredential.js'
import {
  RECOMMENDED_HARNESS_IMAGE,
  type ImageExec,
  refreshHarnessImage,
  resolveHarnessImage,
  resolveRefreshMode,
} from './harnessImage.js'
import { isMothershipMode } from './mothership.js'
import {
  RUNTIME_IDS,
  createRuntimeAdapter,
  resolveRuntimeId,
  unrecognizedRuntimeId,
} from './runtimes/index.js'

const execFileAsync = promisify(execFile)

/**
 * Everything {@link startLocal} accepts. A named interface for the same reason
 * {@link StartOptions} is one: the registry-seam guard asserts against the BOOT ENTRY POINT, and
 * this facade deliberately withholds `buildContainer`, so an app-owned seam missing from here is
 * unreachable on local mode with no escape hatch behind it.
 */
export interface StartLocalOptions {
  env?: NodeJS.ProcessEnv
  host?: string
  /**
   * App-owned DI seam for custom agent kinds: a deployment news a
   * `defaultAgentKindRegistry()`, registers its own kinds on it, and passes it here.
   * Threaded through to `buildLocalContainer` (both the Postgres and mothership paths).
   * Absent → the built-in-only default.
   */
  agentKindRegistry?: AgentKindRegistry
  /**
   * App-owned DI seam for custom initiative presets: a deployment news a
   * `defaultInitiativePresetRegistry()`, registers its own presets on it, and passes it here.
   * Threaded through to `buildLocalContainer` (both the Postgres and mothership paths).
   * Absent → the built-in-only default (generic / docs-refresh / tech-migration).
   */
  initiativePresetRegistry?: InitiativePresetRegistry
  /**
   * App-owned DI seam for custom task types: a deployment news a `defaultTaskTypeRegistry()`,
   * registers its namespaced task types on it, and passes it here. Threaded through to
   * `buildLocalContainer` (both the Postgres and mothership paths). Absent → the built-in
   * picklist only.
   */
  taskTypeRegistry?: TaskTypeRegistry
  /**
   * App-owned DI seam for the deployment's FOUNDATIONAL SERVICES: a deployment news a
   * `defaultFoundationalServiceRegistry()`, registers the shared capabilities its org already
   * runs on it, and passes it here. Threaded through to `buildLocalContainer` (both the Postgres
   * and mothership paths) as the catalog's `builtin` tier. Absent → an empty tier.
   */
  foundationalServiceRegistry?: FoundationalServiceRegistry
  /**
   * App-owned DI seam for the deployment's GENERATIVE BINARY INTEGRATIONS: a deployment news a
   * `defaultBinaryGeneratorRegistry()`, registers the image / music / video generation APIs it
   * pays for on it, and passes it here. Threaded through to `buildLocalContainer` (both the
   * Postgres and mothership paths), where a step carrying the `binary-output` trait selects from
   * them (`stepOptions.binaryOutput.generatorIds`). Absent → an empty registry.
   *
   * **In MOTHERSHIP mode a registration here decides no run**: the set a run resolves against is
   * read from the mothership, which is what the pipeline builder offered it from, and this
   * node's build can only hold a second copy. Register on the mothership's own entry point
   * instead; boot warns and names any ids registered here. (They are still boot-VALIDATED, since
   * a laptop is the cheapest place to learn a definition is malformed.)
   */
  binaryGeneratorRegistry?: BinaryGeneratorRegistry
  /**
   * App-owned DI seam for the deployment's OWN BINARY ARTIFACT STORES: a deployment news a
   * `defaultBinaryStoreRegistry()`, registers stores implementing the `BinaryBlobBackend` port on
   * it, and passes it here. Each becomes a `custom` choice in the account-settings storage picker,
   * and the per-account resolver builds one when an account selects it. Absent → this runtime's
   * `fs` / `db` / `s3` backends alone.
   *
   * **Unlike {@link binaryGeneratorRegistry} this one DOES decide runs in MOTHERSHIP mode**, and
   * for the reason that makes the two different in kind: a generator definition is data a run
   * resolves, so a local copy can disagree with the picker the mothership fed; a store is a live
   * client, and the process about to write the bytes is the only one that can build it. This node
   * stores its own artifacts, so this node's registry is the right one.
   */
  binaryStoreRegistry?: BinaryStoreRegistry
  /**
   * App-owned DI seam for the deployment's PREDEFINED PIPELINES: a deployment news a
   * `defaultPipelineRegistry()`, registers (and retires) pipelines on it, and passes it here.
   * Threaded through to `buildLocalContainer` (both the Postgres and mothership paths). Absent →
   * the built-in palette only.
   *
   * **In MOTHERSHIP mode a registration here decides no run**, exactly as for
   * {@link binaryGeneratorRegistry}: a run ADOPTS its pipeline from the catalog the mothership
   * served the board, so this node's registry can only hold a second copy. Boot warns and names
   * the ids; they are still boot-VALIDATED, because a laptop is the cheapest place to learn a
   * definition names an agent kind nothing registers.
   */
  pipelineRegistry?: PipelineRegistry
  /**
   * App-owned DI seam for custom POLLING GATES: a deployment news a `defaultGateRegistry()`,
   * installs the built-ins with `registerBuiltinGates(...)`, registers its own definitions on it,
   * and passes it here. Threaded through on both paths. Absent → the built-in suite only.
   */
  gateRegistry?: GateRegistry
  /**
   * App-owned DI seam for custom JUDGES: a deployment news a `defaultJudgeRegistry()`, registers
   * its `JudgeDefinition`s on it, and passes it here. Threaded through on both paths. Absent →
   * the empty default (the platform ships no judges).
   */
  judgeRegistry?: JudgeRegistry
  /**
   * App-owned DI seam for custom STEP COMPLETION RESOLVERS, threaded through on both paths.
   * Absent → the empty default (the built-in `merger` resolver is a privileged engine built-in,
   * not a registry entry).
   */
  stepResolverRegistry?: StepResolverRegistry
  /**
   * App-owned DI seam for VCS PROVIDERS, threaded through on both paths. Absent → the built-in
   * `github` + `gitlab` bundle.
   */
  vcsRegistry?: VcsProviderRegistry
  /**
   * App-owned DI seam for the deployment's best-practice PROMPT FRAGMENTS and the per-task-type
   * default sets that select them, threaded through on both paths. Absent → the shipped catalog
   * alone.
   *
   * **In MOTHERSHIP mode this node reads the pool from the mothership**, so a registration here is
   * not what any run folds; boot warns and names the ids. Same shape, and the same reason, as
   * {@link binaryGeneratorRegistry}.
   */
  promptFragmentRegistry?: PromptFragmentRegistry
  /**
   * Raise selected boot-validation WARNINGS to errors, failing boot instead of logging (parity with
   * the Node facade's `start()`).
   *
   * The severities are set by what the PLATFORM can know, and for one warning the DEPLOYMENT knows
   * more: `task_type_unknown_fragment` cannot separate a typo in a code-owned fragment id from a
   * legitimate account/workspace-tier id that only merges per workspace at run time. A deployment
   * whose operations reference only fragments it registers itself has no second cause, and for it
   * the warning names an operation silently running short of its own standing guidance.
   *
   * A laptop is the cheapest place to learn about such a typo, so escalating here and on `start()`
   * from one shared predicate is the intended shape.
   */
  escalateRegistrationWarning?: (problem: RegistrationProblem) => boolean
  /**
   * Build the resolver that supplies a registered capability's CREDENTIALS at dispatch. A tool
   * server's (MCP) and a generative binary integration's alike. Threaded through to
   * `buildLocalContainer` (both the Postgres and mothership paths). Absent → the
   * deployment-environment default, `createEnvToolSecretResolver(env)`.
   *
   * This is the `ToolSecretResolver` port's own extension seam: a deployment holding
   * PER-WORKSPACE credentials implements the port and passes it here, and nothing else in the
   * dispatch path changes. The narrower env bound composes through the same option,
   * `(env) => createEnvToolSecretResolver(env, { allowKeys: [...] })`, which is the shape a
   * MOTHERSHIP-MODE node wants: its integration definitions are authored by the mothership, and
   * the environment their keys are read from is this laptop's. (The platform's OWN
   * configuration variables need no such list; they are refused with no configuration at all.)
   */
  createToolSecretResolver?: (env: NodeJS.ProcessEnv) => ToolSecretResolver
  /**
   * Whether this node's environment answers a capability credential the workspace has not
   * stored. Defaults to true, which is right for a laptop: the operator sets the variable they
   * already set for everything else. A multi-tenant deployment built on this facade sets it
   * false so a workspace that has typed nothing resolves nothing. Ignored when
   * {@link createToolSecretResolver} is set, which replaces the chain outright.
   */
  capabilityCredentialEnvironmentFallback?: boolean
  /**
   * App-owned backend registries (environment + runner kind → provider), registered BY
   * REFERENCE, the same seam the Node facade exposes on `buildContainer.backendRegistries`.
   * A deployment builds `createBackendRegistries()`, registers its custom backend(s) onto it
   * (e.g. a custom ephemeral-environment provider), and passes it here; it is threaded into
   * `buildLocalContainer` on both the Postgres and mothership paths. Absent → the built-in-only
   * default (`manifest` + `kubernetes`).
   *
   * This lets a custom-backend deployment call `startLocal()` (and inherit its boot preflights
   * harness-image refresh, container-runtime probe, PAT/auth warnings) instead of
   * re-implementing the boot path (`start()` + `buildLocalContainer` by hand) just to inject a
   * registry, which silently forgoes those preflights.
   */
  backendRegistries?: BackendRegistries
  /**
   * The catalog id of the built-in model preset a fresh workspace is seeded with as its
   * DEFAULT (`MODEL_PRESET_SEED_IDS.{kimi,glm,claude}`). A local deploy-app wrapper passes this
   * to change the out-of-the-box default without editing library code. Threaded into
   * `buildLocalContainer` on BOTH the Postgres and mothership paths. Applied only at FIRST seed
   * of a workspace's preset library, so a user's later manual default choice always wins.
   * Omitted ⇒ the local facade default (Claude Opus 5).
   */
  defaultModelPresetId?: string
  /**
   * A deployment's pre-declared environment-handler seeds (each a `RegisterHandlerInput`). A
   * local deploy-app wrapper passes this so the server auto-registers its
   * infra handler per workspace with no manual SPA step. Threaded into `buildLocalContainer` on
   * BOTH the Postgres path (through `start()` → `o`) and the mothership path, and used to
   * boot-backfill every existing workspace; new workspaces are seeded by `WorkspaceService.create`.
   * Omitted ⇒ no seeding.
   */
  seedEnvironmentHandlers?: RegisterHandlerInput[]
  /**
   * A deployment's pre-declared SHARED STACKS (each a `CreateSharedStackInput`): the long-lived
   * compose infra its previews attach to. Threaded on BOTH local boot paths and backfilled
   * exactly like {@link seedEnvironmentHandlers}. A seed's compose layers may be inline
   * documents, paths in another repo, or paths in the stack's own clone, so a local deployment
   * can declare its whole infra dependency set in code, including a stack with no repo of its
   * own. Bringing one UP needs the host Docker daemon, which local mode has. Omitted ⇒ no seeding.
   */
  seedSharedStacks?: CreateSharedStackInput[]
}

// Boot the local-mode service. It reuses the Node facade's `start()` — Postgres +
// pg-boss + the execution worker + sweepers, served over @hono/node-server — passing
// the local composition root so agent jobs run in local containers (Docker/Podman/
// OrbStack/Colima/Apple `container`) and GitHub is reached via a PAT. Requires
// DATABASE_URL (point it at the local Postgres); set LOCAL_HARNESS_IMAGE to run
// repo-operating agent jobs (without it the board still serves and only container
// kinds fail, loudly).
//
// A native ephemeral-environment backend can be selected per-workspace from the env-backend
// registry by the stored connection `kind`. A built-in kind (e.g. `kubernetes`) is registered
// as an import side effect; a deployment's OWN backend is registered by reference into the
// `backendRegistries` seam below (no import side effect to rely on). `buildContainer` itself is
// intentionally NOT exposed: overriding it would discard local mode's differentiators (local
// container transport, PAT-backed GitHub client) — `backendRegistries` is the narrow seam that
// injects a custom backend without giving that up.
export async function startLocal(
  options: StartLocalOptions = {},
): Promise<Awaited<ReturnType<typeof start>>> {
  const env = options.env ?? process.env
  // Same first move as the Node facade's `start`: verbosity, then the process-level guards.
  // The mothership path never reaches `start()`, so arming them here (not only there) is what
  // makes both local topologies crash-report identically.
  setLogLevel(parseLogLevel(env.LOG_LEVEL))
  installProcessFailureGuards(logger)
  try {
    return await bootLocal(options, env)
  } catch (err) {
    // A mandatory secret / config value is missing or invalid (e.g. AUTH_SESSION_SECRET,
    // ENCRYPTION_KEY, DATABASE_URL). Rather than exiting — which drops the developer's SPA onto a
    // bare "can't reach the backend" panel — keep the port reachable serving the fallback backend
    // so the UI explains exactly what to add to their .env. (The Postgres path's own config errors
    // are already handled inside `start()`; this covers the ones thrown by `applyLocalDefaults` and
    // the mothership path, before `start()` runs.) Advertise the one-step `.env` generator (the
    // `cat-factory env` CLI) above the per-variable remedies — the same advice `start()` layers on
    // the errors it catches itself (DATABASE_URL), via `augmentConfigProblems` below.
    if (isConfigValidationError(err)) {
      return serveMisconfigured(withLocalEnvCliAdvice(err.problems), env, options.host)
    }
    throw err
  }
}

/** The real local boot, wrapped by {@link startLocal} so a {@link ConfigValidationError} falls back. */
async function bootLocal(
  options: NonNullable<Parameters<typeof startLocal>[0]>,
  env: NodeJS.ProcessEnv,
): Promise<Awaited<ReturnType<typeof start>>> {
  // The auth gate defaults OPEN in local mode and the listener binds to all interfaces
  // (so on native Linux Docker the agent containers can reach the LLM proxy via the
  // bridge gateway). That combination means anyone on your network can reach the API —
  // surface it so it is a choice, not a surprise. Lock it down with AUTH_DEV_OPEN=false,
  // or HOST=127.0.0.1 on Docker Desktop (where host.docker.internal still resolves).
  const localized = applyLocalDefaults(env)

  // Time local mode's OWN preflights (app-startup initiative, item 1): the Node `start()` it
  // delegates to logs its own phase breakdown, but the runtime preflight runs BEFORE that and is
  // otherwise untimed. One summary line makes a wedged container CLI visible without guessing. The
  // github.com PAT probe used to be awaited here too (item 6) but is now fire-and-forget, so the
  // `patProbe` bracket only measures the near-instant kick — it no longer stalls the boot path.
  const bootClock = startBootClock()

  // Container-runtime preflight: log the selected runtime + its capabilities + the host
  // alias the harness will use to reach this service, and probe that the CLI is present.
  // A misconfigured runtime then fails loud at boot rather than on the first dispatch.
  await preflightRuntime(localized)
  bootClock.mark('runtimePreflight')

  // Harness-image preflight: resolve the effective image (an explicit LOCAL_HARNESS_IMAGE, else
  // the backend-matched RECOMMENDED_HARNESS_IMAGE) and refresh it so a rerun can't launch a
  // stale — or, via a mutable `:latest`, a too-new — harness image. Fire-and-forget so a slow
  // (potentially multi-GB) pull never delays serving the board: it never throws, and the
  // container transport is built lazily on first dispatch, so the refresh races ahead of any
  // actual use. Disable with LOCAL_HARNESS_IMAGE_REFRESH=off.
  void runBestEffort(logger, 'local.preflightHarnessImage', () => preflightHarnessImage(localized))

  // NB: reaping per-run containers a previous run orphaned (a crash/hard kill leaves exited
  // managed containers behind) + draining pool orphans + pre-warming is done on the SERVING
  // transport, which `buildLocalContainer` builds (with the DB-stored pool config) and warms
  // eagerly at boot when an image is configured — so it is not repeated here.

  // Source control is reached via a PAT in local mode (there is no GitHub-App connect flow):
  // `GITHUB_PAT` / `GITLAB_PAT`, else the one a developer installed from the sign-in screen.
  // With NONE the board still serves, but every repo-operating agent step — clone, push, open
  // PR/MR, the CI gate, the real merge — fails. Surface it at boot with a click-through URL that
  // pre-selects the scopes, so it is a one-step fix rather than a runtime surprise. This reads
  // the credential through a throwaway source: the container builds its own (the one the running
  // server then reads through), and holding a second sqlite handle open for the process lifetime
  // to answer one boot question is not worth it.
  const bootCredentials = createLocalVcsCredentialSource(localized)
  const bootCredential = bootCredentials.current()
  bootCredentials.close()
  if (!bootCredential) {
    logger.warn(
      `local mode: this deployment has no source-control token — agent steps that clone, push, ` +
        `open PRs/MRs, gate on CI or merge will fail. Create a GitHub token (scopes pre-selected) ` +
        `at ${githubPatCreationUrl()} and sign in with it on the sign-in screen (no restart), or ` +
        `set GITHUB_PAT / GITLAB_PAT in your .env and restart.`,
    )
  } else if (bootCredential.provider === 'github') {
    // A PAT IS set (GitHub mode): validate it once at boot so an invalid / expired / under-scoped
    // token surfaces here — with the same one-click fix as the missing case — instead of failing
    // opaquely on the first clone/push/PR/CI/merge later. FIRE-AND-FORGET (app-startup initiative,
    // item 6): the probe is a real github.com round-trip and best-effort diagnostics only (an
    // invalid PAT still fails loudly on first use), so it must not hold the boot path for a network
    // hop — it logs its warning if/when the bounded probe later resolves.
    warnOnGitHubPatProblemInBackground(localized, bootCredential.token, logger)
  }
  bootClock.mark('patProbe')
  const preflight = bootClock.summary()
  logger.info(`local mode: preflights done in ${preflight.totalMs} ms`, preflight)

  if (localized.AUTH_DEV_OPEN !== 'false' && !env.HOST?.trim()) {
    logger.warn(
      'local mode: the auth gate is OPEN and the server binds to all interfaces — anyone ' +
        'on your network can reach the API. Set AUTH_DEV_OPEN=false, or HOST=127.0.0.1 on ' +
        'Docker Desktop, to restrict it.',
    )
  }

  // Mothership mode boots WITHOUT Postgres (no DATABASE_URL / migrate / pg-boss): org/durable
  // state lives on the mothership and runs are driven by the in-process work runner. Take the
  // dedicated boot path instead of the Node facade's `start()` (which requires Postgres).
  if (isMothershipMode(localized)) {
    return startLocalMothership(localized, options.host, options)
  }

  return start({
    // The LOCALIZED env, not the raw one: `start()` builds the shared app via `createApp`,
    // whose CORS middleware reads `env.ENVIRONMENT` / `env.CORS_ALLOWED_ORIGINS` DIRECTLY
    // (not via AppConfig). Passing the raw env would drop every `applyLocalDefaults` default
    // for those direct reads — the reason the SPA hit a CORS wall until the operator set
    // CORS_ALLOWED_ORIGINS by hand. `buildLocalContainer` re-applies the defaults idempotently.
    env: localized,
    host: options.host,
    agentKindRegistry: options.agentKindRegistry,
    initiativePresetRegistry: options.initiativePresetRegistry,
    taskTypeRegistry: options.taskTypeRegistry,
    foundationalServiceRegistry: options.foundationalServiceRegistry,
    binaryGeneratorRegistry: options.binaryGeneratorRegistry,
    binaryStoreRegistry: options.binaryStoreRegistry,
    pipelineRegistry: options.pipelineRegistry,
    gateRegistry: options.gateRegistry,
    judgeRegistry: options.judgeRegistry,
    stepResolverRegistry: options.stepResolverRegistry,
    vcsRegistry: options.vcsRegistry,
    promptFragmentRegistry: options.promptFragmentRegistry,
    escalateRegistrationWarning: options.escalateRegistrationWarning,
    createToolSecretResolver: options.createToolSecretResolver,
    capabilityCredentialEnvironmentFallback: options.capabilityCredentialEnvironmentFallback,
    // A mandatory value missing from the reused Node boot (DATABASE_URL) is caught inside `start()`,
    // so it never reaches this facade's own catch above — thread the same local-mode `.env`-CLI
    // advertisement through `start()`'s misconfiguration path so those problems get it too.
    augmentConfigProblems: withLocalEnvCliAdvice,
    // Forward the deployment's default-preset choice: `start()` puts it on the `o` it hands the
    // `buildContainer` override below, so `buildLocalContainer` picks it up (undefined ⇒ local's
    // Claude default). Kept off the `buildLocalContainer` call directly so there is one path.
    defaultModelPresetId: options.defaultModelPresetId,
    // Forward the deployment's environment-handler seeds the same way: `start()` puts them on `o`,
    // so `buildLocalContainer` (via `...options`) hands them to `buildNodeContainer` → `createCore`,
    // and `start()`'s post-listen backfill seeds every existing workspace. Undefined ⇒ no seeding.
    seedEnvironmentHandlers: options.seedEnvironmentHandlers,
    // …and the declared shared stacks along the same path, so a local deployment can describe its
    // whole infra dependency set (inline compose documents included) in code.
    seedSharedStacks: options.seedSharedStacks,
    // Inject the deployment's backend registries (if any) by reference — `start()` never puts a
    // `backendRegistries` on `o`, so this can't clobber one, and when absent `buildLocalContainer`
    // falls back to `createBackendRegistries()` (the built-in-only default). Unchanged from the
    // prior `buildLocalContainer(o)` when no registry is passed.
    buildContainer: (o) =>
      buildLocalContainer({ ...o, backendRegistries: options.backendRegistries }),
    // Pass the repo projection through live: local mode seeds `github_repos` via the
    // out-of-process `link-repo` CLI and runs single-node with no invalidation bus, so an
    // in-memory TTL'd entry would keep serving a pre-link (or pre-monorepo-flag) projection
    // after the CLI writes it. Same isolate-safe reasoning as the Worker; the resolver reads
    // live and the (no-op) invalidations on the in-process sync/bootstrap paths stay wired.
    cachesProfile: {
      repoProjection: { ...DEFAULT_APP_CACHES_PROFILE.repoProjection, enabled: false },
    },
  })
}

/**
 * Boot the local-mode service in MOTHERSHIP mode: no Postgres, no pg-boss. The container
 * (built by {@link buildLocalContainer}) composes the remote (RPC-backed) org repositories +
 * the local `node:sqlite` credential store, and carries the in-process work runner that drives
 * runs through the same advance/poll loop. This serves the SAME shared Hono app + WebSocket
 * event transport the Node boot does — only the durable-execution + persistence substrate
 * differs.
 *
 * The periodic Postgres-backed sweepers the Node `start()` runs (retention, recurring-pipeline
 * fire, notification escalation, Kaizen) are intentionally NOT started here: they prune/scan
 * stores that live on the mothership (its own cron owns them). Durable execution IS now provided
 * locally — the container's work runner is backed by a file-based `node:sqlite` work queue (the
 * no-pg-boss analogue), so a crash/restart re-drives in-flight runs; telemetry local-first sync
 * remains a later initiative slice (PR 5).
 */
async function startLocalMothership(
  env: NodeJS.ProcessEnv,
  host: string | undefined,
  /**
   * The deployment extension seams threaded into `buildLocalContainer`.
   *
   * Typed as the WHOLE {@link StartLocalOptions} rather than a hand-listed subset, which is what
   * it was: a second enumeration of the same seams, one entry per thing somebody remembered. It
   * drifted exactly the way that shape always does, and the mothership path is the worst place
   * for it, because this is the boot that has no `buildContainer` escape hatch behind it. Now a
   * seam added to the entry point reaches here by construction, and `env`/`host` (which this path
   * takes as its own parameters) are simply not read off it.
   */
  extensions: StartLocalOptions,
): Promise<Awaited<ReturnType<typeof serve>>> {
  const {
    agentKindRegistry,
    initiativePresetRegistry,
    backendRegistries,
    defaultModelPresetId,
    taskTypeRegistry,
    foundationalServiceRegistry,
    binaryGeneratorRegistry,
    binaryStoreRegistry,
    pipelineRegistry,
    gateRegistry,
    judgeRegistry,
    stepResolverRegistry,
    vcsRegistry,
    promptFragmentRegistry,
    createToolSecretResolver,
    capabilityCredentialEnvironmentFallback,
    seedEnvironmentHandlers,
    seedSharedStacks,
  } = extensions
  logger.info(
    'local mode: booting in MOTHERSHIP mode (no local Postgres; org state served remotely)',
    { mothership: env.LOCAL_MOTHERSHIP_URL },
  )
  // Shared with the engine's event publisher (wired inside the container) and the HTTP
  // server's WebSocket upgrade listener below, exactly as the Node `start()` does. Local
  // mode is always single-node, so the bare hub IS the real-time sink — no cross-node
  // propagator (Redis) is wired here.
  const realtimeHub = new NodeRealtimeHub()
  const container = buildLocalContainer({
    env,
    realtimeSink: realtimeHub,
    // The same hub, as its room-observability side: mothership mode opens an upstream subscription
    // per workspace someone is actually watching here (see `MothershipEventSubscriber`).
    realtimeRooms: realtimeHub,
    agentKindRegistry,
    initiativePresetRegistry,
    backendRegistries,
    defaultModelPresetId,
    taskTypeRegistry,
    foundationalServiceRegistry,
    binaryGeneratorRegistry,
    binaryStoreRegistry,
    pipelineRegistry,
    gateRegistry,
    judgeRegistry,
    stepResolverRegistry,
    vcsRegistry,
    promptFragmentRegistry,
    createToolSecretResolver,
    capabilityCredentialEnvironmentFallback,
    seedEnvironmentHandlers,
    seedSharedStacks,
  })

  // Export logs to the OTLP endpoint (a no-op unless `OTEL_LOGS=true` on top of a configured
  // exporter). Wired here as well as in `start()` because this path never runs `bootServer`:
  // without it, mothership mode would be the one Node-hosted shape whose logs stop at stdout.
  const logExport = startOtelLogExport(container.config.otel, logger)

  // Validate registered gates / agent kinds once before serving (parity with `start()`). The
  // foundational-service definitions are still validated here even though this node resolves the
  // tier remotely (below): they are the SAME code the mothership boots, so a malformed one is a
  // real defect and a laptop is the cheapest place to learn about it.
  validateRegistrationsOnce({
    // The whole container. This call site is why `ValidatedRegistries` is one object: it used to
    // hand-list five registries while claiming parity with `start()`, so a custom task type naming
    // an unregistered pipeline (and a non-namespaced id, a duplicate field key, an optionless
    // picker, a `showWhen` on an undeclared field) booted CLEAN on a laptop and failed on the
    // Postgres path. There is now nothing here to fall behind.
    registries: container,
    onWarn: (problem) => logger.warn(problem.message, { code: problem.code }),
    // Same deployment policy the Postgres path applies, threaded here too: a boot that validates
    // the same registrations must reach the same verdict about them, or a laptop is the one place
    // an escalated defect stays quiet.
    escalateWarning: extensions.escalateRegistrationWarning,
  })

  // In mothership mode the catalog's `builtin` tier comes from the MOTHERSHIP, so anything this
  // node registered locally is not part of any catalog it resolves. Say so, naming the ids: this
  // is the shape a deployment written before the tier crossed the machine API has (it had to
  // register on both entry points), and silently ignoring it would swap one invisible failure for
  // another. The registrations are harmless — the same build registers them on the mothership,
  // which is where they take effect.
  const localEstate = container.foundationalServiceRegistry.entries()
  if (localEstate.length > 0) {
    logger.warn(
      'local mode: foundational services registered on this node are NOT used in mothership ' +
        'mode — the catalog’s builtin tier is read from the mothership, which is authoritative ' +
        'for the deployment’s estate. Register them on the mothership’s own entry point.',
      { serviceIds: localEstate.map((entry) => entry.id) },
    )
  }

  // The same courtesy for the generative integrations, and the one that would have told a
  // deployment it was carrying a redundant registration: before the set crossed the machine API,
  // registering on BOTH entry points was the only shape that worked, so the line reads like
  // deliberate wiring rather than the workaround it was. Naming the ids is what makes it
  // actionable — silently ignoring them would swap one invisible failure for another.
  const localGenerators = container.binaryGeneratorRegistry.ids()
  if (localGenerators.length > 0) {
    logger.warn(
      'local mode: generative binary integrations registered on this node are NOT used in ' +
        'mothership mode — a run resolves a step’s generatorIds against the mothership, which ' +
        'is what the pipeline builder offered them from. Register them on the mothership’s own ' +
        'entry point.',
      { binaryGeneratorIds: localGenerators },
    )
  }

  // The standards pool, whose registration is the quietest of the family to lose: a run folds
  // guidance the org never wrote, or none at all, and a reviewer's adherence report reads perfectly
  // well either way.
  //
  // Unlike its two siblings this registry is NOT empty by default (it carries the shipped
  // catalog), so the warn has to name what the DEPLOYMENT added rather than everything present, or
  // every mothership boot would list ~40 built-ins as a misconfiguration. Both shapes of addition
  // count: a fragment the catalog does not ship, AND an override of one it does, which is a
  // registration that equally no longer decides any run. Which is why the comparison is the WHOLE
  // fragment and not its body: re-registering a shipped id with the same guidance under a new
  // `title`, `version` or `brief` is an override by every definition that matters here, and a
  // body-only check called it a built-in and said nothing.
  const localFragments = container.promptFragmentRegistry.all().filter((fragment) => {
    const builtin = FRAGMENTS_BY_ID.get(fragment.id)
    return !builtin || !isDeepStrictEqual(fragment, builtin)
  })
  if (localFragments.length > 0) {
    logger.warn(
      'local mode: prompt fragments registered on this node are NOT what a run folds in ' +
        'mothership mode: the pool (and each task type’s default set) is read from the ' +
        'mothership, which is authoritative for the deployment’s standards. Register them on the ' +
        'mothership’s own entry point.',
      { fragmentIds: localFragments.map((fragment) => fragment.id) },
    )
  }

  // The fourth member of the same family, and the one whose disposition had to be DECIDED rather
  // than copied. A pipeline a deployment registers in code is state a RUN resolves, so the org-state
  // rule points at an `/internal/*` read like the foundational tier and the generator set above. It
  // gets the boot WARN instead, and the difference that earns it is what happens when the two builds
  // disagree:
  //
  // - a definition the MOTHERSHIP has and this node does not is offered by the board (the SPA reads
  //   the mothership) and then refused at `adoptForRun`, which finds no stored row and no catalog
  //   entry and returns null. That is a loud, named refusal at run start, not the silent omission an
  //   empty foundational tier produces, and silence is the whole reason those two read remotely;
  // - a definition this node has and the mothership does not is adopted into a workspace row
  //   through the REMOTE repository, so it lands on the mothership and stops being local.
  //
  // The other half of the reasoning is that `seedPipelines`/`retiredPipelines` are synchronous and
  // read on every board list, so a remote source would make the catalog an awaited network read on
  // a hot path to remove a divergence that already fails safely. If a future change makes the skew
  // silent (a run resolving a definition with no row and no refusal), this becomes a `PipelineSource`
  // and the reasoning above is the thing to re-read.
  const localPipelines = container.pipelineRegistry.registered()
  if (localPipelines.length > 0) {
    logger.warn(
      'local mode: pipelines registered on this node are NOT what a board offers in mothership ' +
        'mode: the SPA reads the catalog from the mothership, so a definition only this node ' +
        'knows is invisible there, and one only the mothership knows is refused at run start. ' +
        'Register them on the mothership’s own entry point.',
      { pipelineIds: localPipelines.map((pipeline) => pipeline.id) },
    )
  }

  // Backfill the deployment's declared environment-handler seeds onto every existing workspace —
  // the mothership path builds `buildLocalContainer` directly and never runs `bootServer`, so it
  // must run the same best-effort backfill itself (new workspaces are seeded by
  // WorkspaceService.create). Fire-and-forget so it doesn't delay serving; a no-op when unwired.
  void backfillDeclaredSeeds(container, logger)

  const app = createApp(container, env)
  // Shared serve + WebSocket-upgrade helper (one implementation with `start()`, so port/host
  // resolution can't drift). The shutdown sequence stays local because it differs from `start()`:
  // no pg-boss/pool to stop, but the local credential SQLite handle to release.
  const { server, stopRealtime } = serveAppWithRealtime({
    app,
    realtimeHub,
    auth: container.config.auth,
    env,
    host,
    label: 'cat-factory local (mothership) server',
  })

  let shuttingDown = false
  const shutdown = async (signal: string) => {
    if (shuttingDown) return
    shuttingDown = true
    logger.info('shutting down cat-factory local (mothership) server', { signal })
    stopRealtime()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    // Release the local credential SQLite handle (mothership mode owns it).
    await container.onShutdown?.()
    // LAST: detach the log sink and deliver what it still holds, so the shutdown's own lines
    // leave the process before it does (same ordering as the Node facade's shutdown).
    await logExport.stop()
    process.exit(0)
  }
  process.once('SIGTERM', () => void shutdown('SIGTERM'))
  process.once('SIGINT', () => void shutdown('SIGINT'))

  return server
}

/**
 * Log the resolved container runtime + capabilities + networking, and probe that its CLI
 * is installed. Non-fatal: the board still boots if the binary is missing (only
 * container-backed agent kinds then fail), mirroring how a missing image is handled.
 */
async function preflightRuntime(localized: NodeJS.ProcessEnv): Promise<void> {
  // Name a typo'd LOCAL_CONTAINER_RUNTIME at boot: `resolveRuntimeId` silently falls back to
  // docker for any unrecognised value, so without this a `LOCAL_CONTAINER_RUNTIME=pod man` runs
  // docker with no signal. Greppable single line: the rejected value, the accepted set, the
  // fallback taken (error-message coverage A9).
  const rejectedRuntime = unrecognizedRuntimeId(localized)
  if (rejectedRuntime !== undefined) {
    logger.warn(
      `local mode: LOCAL_CONTAINER_RUNTIME='${rejectedRuntime}' is not a recognised runtime ` +
        `(accepted: ${RUNTIME_IDS.join(', ')}) — falling back to 'docker'. See ` +
        `${DOCS.envVars(ENV_VARS_ANCHORS.localMode)}.`,
      {
        rejected: rejectedRuntime,
        accepted: RUNTIME_IDS,
        fallback: 'docker',
        docsUrl: DOCS.envVars(ENV_VARS_ANCHORS.localMode),
      },
    )
  }
  const adapter = createRuntimeAdapter(localized)
  logger.info('local mode: container runtime selected', {
    runtime: resolveRuntimeId(localized),
    binary: adapter.binary,
    localDind: adapter.capabilities.localDind,
    hostAlias: adapter.hostAlias,
    publicUrl: localized.PUBLIC_URL,
  })
  if (!adapter.capabilities.localDind) {
    logger.info(
      `local mode: the '${resolveRuntimeId(localized)}' runtime cannot run the Tester's local ` +
        `docker-compose infra (no Docker-in-Docker). Tasks must use the ephemeral test ` +
        `environment (with an environment provider configured) or a 'No infra dependencies' ` +
        `service; a local-infra Tester run is refused at start.`,
    )
  }
  try {
    await execFileAsync(adapter.binary, ['--version'], { timeout: 10_000 })
  } catch (err) {
    logger.warn(
      `local mode: container CLI '${adapter.binary}' is not runnable — repo-operating agent ` +
        `steps will fail until it is installed and on PATH (or set LOCAL_DOCKER_BINARY / ` +
        `LOCAL_CONTAINER_RUNTIME).`,
      { err: err instanceof Error ? err.message : String(err), binary: adapter.binary },
    )
  }
}

/**
 * Resolve + refresh the executor-harness image at boot so a rerun uses the version this backend
 * is matched to rather than a stale local copy. Delegates the logic (and its logging) to
 * {@link refreshHarnessImage}; this wrapper only supplies the runtime binary + a real exec seam.
 */
async function preflightHarnessImage(localized: NodeJS.ProcessEnv): Promise<void> {
  const adapter = createRuntimeAdapter(localized)
  await refreshHarnessImage({
    image: resolveHarnessImage(localized),
    recommended: RECOMMENDED_HARNESS_IMAGE,
    binary: adapter.binary,
    runtimeId: resolveRuntimeId(localized),
    mode: resolveRefreshMode(localized),
    exec: makeImageExec(adapter.binary),
    log: { info: (m) => logger.info(m), warn: (m) => logger.warn(m) },
  })
}

/** A container-CLI runner that captures stdout + a normalised exit status (0 = success). */
function makeImageExec(binary: string): ImageExec {
  return async (args) => {
    try {
      const { stdout } = await execFileAsync(binary, args, {
        timeout: 120_000,
        maxBuffer: 10 * 1024 * 1024,
      })
      return { status: 0, stdout: stdout ?? '' }
    } catch (err) {
      const e = err as { code?: number; stdout?: string }
      return { status: typeof e.code === 'number' ? e.code : 1, stdout: e.stdout ?? '' }
    }
  }
}
