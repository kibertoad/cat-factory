import type {
  Clock,
  CreateSharedStackInput,
  DetectSharedStackInput,
  IdGenerator,
  Logger,
  PreflightRef,
  PreflightResult,
  RecipeStepRecorder,
  RunRepoContext,
  SharedStack,
  SharedStackEnsureResult,
  SharedStackRecommendation,
  SharedStackRepository,
  UpdateSharedStackInput,
  VcsProvider,
  WorkspaceRepository,
} from '@cat-factory/kernel'
import {
  assertFound,
  ConflictError,
  describeComposeSource,
  getErrorMessage,
  noopLogger,
  redactSecrets,
  requireWorkspace,
  runBestEffort,
  ValidationError,
} from '@cat-factory/kernel'
import {
  type ComposeRuntime,
  classifyComposePs,
  composeBringUpNeedsRepo,
  composeSourceEscapeIssues,
  DEFAULT_RECIPE_HEALTH_GATE,
  tailOutput,
} from '../compose/compose-environment.logic.js'
import {
  type ComposeLayerPlan,
  type ComposeLayerPlanResult,
  planComposeLayers,
} from '../compose/compose-sources.js'
import { formatPreflightFailure, preflightBlockingFailures } from '../preflight/PreflightService.js'
import { runHealthGate, runRecipeStep } from '../compose/recipe-runner.js'
import {
  type DetectionConventions,
  detectSharedStack,
} from '../environments/provision-detect.logic.js'
import { RepoReadError } from '../environments/repo-read-error.js'
import { parseVcsCloneUrl } from './shared-stack-detect.logic.js'

export interface SharedStackServiceDependencies {
  sharedStackRepository: SharedStackRepository
  workspaceRepository: WorkspaceRepository
  idGenerator: IdGenerator
  clock: Clock
  /**
   * The host Docker seam used to bring a stack UP / tear it DOWN. Wired ONLY on a facade with a
   * host daemon (the local facade); absent on the Worker / plain Node, where CRUD still works but
   * `ensureUp`/`teardown` refuse with a clear "requires the local Docker runtime" error (the
   * documented compose runtime-binding exception — persistence stays symmetric, execution does not).
   */
  composeRuntime?: ComposeRuntime
  /**
   * Optional VCS token used to CLONE a stack's repo during bring-up (threaded to the runtime's
   * `checkout` as `token`). Wired on the local facade from the same source-control PAT the agent
   * containers push with, so a shared stack whose `cloneUrl` is a PRIVATE repo can be brought up.
   * Absent (or answering undefined) ⇒ the clone runs unauthenticated (public repos only), exactly
   * as before.
   *
   * A getter, not a value: the only facade that wires it can have its credential installed while
   * the server runs, and a token captured at container-build time would be the one the process
   * booted with forever.
   */
  cloneToken?: () => string | undefined
  /**
   * Optional host-bound preflight runner: given the stack's declared `prerequisites`, returns one
   * verdict per check. Wired ONLY where the host-probe seam exists (the local facade — the same
   * runtime binding as {@link composeRuntime}); it is the integrations `PreflightService.run` seam.
   * When a stack declares `prerequisites` but this is ABSENT (no host daemon), the bring-up fails
   * loudly rather than silently skipping a declared machine-prerequisite gate — mirroring the
   * compose provider's `runPreflights` seam. Absent + no declared prerequisites ⇒ a no-op.
   */
  runPreflights?: (refs: PreflightRef[]) => Promise<PreflightResult[]>
  /**
   * Optional per-step provisioning-log recorder factory: given a stack, returns a recorder the
   * bring-up streams per-step verdicts through (clone, network, env-file, up, each setup step,
   * health gate), so the Infrastructure "View logs" drawer shows which step ran/died. Absent ⇒ no
   * per-step logging (the status/lastError on the record are still updated).
   */
  provisioningLog?: (stack: SharedStack) => RecipeStepRecorder
  /**
   * Resolve a VCS-neutral, workspace+repo-bound {@link RunRepoContext} for checkout-free repo
   * reads — the SAME seam the environment connection service uses to auto-detect provisioning.
   * Wired by the runtime from the workspace's VCS connection + the supplied repo coords. Two
   * consumers: {@link SharedStackService.detect}, and the bring-up's `repo` compose layers (a path
   * in ANOTHER project, read without cloning it). Absent ⇒ detection reports "no VCS connection"
   * and a stack declaring a `repo` layer fails its bring-up with that cause; CRUD and a stack whose
   * layers are all `path` / `inline` are unaffected.
   */
  resolveRepoFilesForWorkspace?: (
    workspaceId: string,
    coords: { owner: string; repo: string; provider?: VcsProvider },
  ) => Promise<RunRepoContext | null>
  /**
   * Deployment-level, ADDITIVE extensions to the built-in detection conventions (extra compose file
   * names/dirs, seed dirs, env-template dirs), passed straight into {@link detectSharedStack} so
   * shared-stack detection honours the same house conventions as service-provisioning detection.
   * Absent ⇒ built-in behaviour.
   */
  detectionConventions?: DetectionConventions
  /** Where the best-effort teardown below reports a failed `compose down`. Absent ⇒ `noopLogger`. */
  logger?: Logger
}

// Bound (ms) for the plain compose calls (network / down / version) so a wedged daemon can't hang
// a bring-up/teardown forever; `up` clears its own health-gate budget separately.
const SHORT_TIMEOUT_MS = 60_000
const UP_TIMEOUT_MS = 330_000

/**
 * Refuse an unsaveable stack definition at the WRITE boundary, so the operator — or the deployment
 * declaring a stack programmatically — hears about it on save rather than on a bring-up that has
 * already flipped the row to `starting`. Two rules, both about the compose layers:
 *
 * - a stack that reads committed files (a `path` compose layer, an env-file template, a
 *   `copy-file` / `stdinFile` step) needs a repo to read them FROM, or the bring-up clones nothing
 *   and then can't find its compose file;
 * - a layer that names where it is materialized must land INSIDE the checkout. The bring-up refuses
 *   an escaping layer too (`planComposeLayers`), but that is the last line of defence: a stack
 *   whose stored definition can never be brought up should not be storable in the first place.
 */
/**
 * The runtime seam this stack's shape needs but the wired {@link ComposeRuntime} doesn't have, or
 * null when it can be brought up. Keyed off the same {@link composeBringUpNeedsRepo} predicate
 * `prepareWorkingTree` branches on, so the gate and the code it guards can't disagree about which
 * seam is about to be called:
 *
 * - a stack that reads COMMITTED files needs `checkout` (to clone them) and `copyCheckoutFile` (to
 *   materialize its env-file templates);
 * - a stack declared entirely in code needs `workingDir` to stand an empty tree up instead, plus
 *   `writeCheckoutFile`, since by construction every one of its layers must be written.
 *
 * `writeCheckoutFile` is deliberately NOT required of the first shape: a stack of plain in-repo
 * paths materializes nothing, so it must stay brought-up-able on a runtime lacking that seam. The
 * layers that DO need it are checked individually, where the failure can name the layer.
 */
function missingRuntimeCapability(runtime: ComposeRuntime, stack: SharedStack): string | null {
  if (composeBringUpNeedsRepo(stack)) {
    return runtime.checkout && runtime.copyCheckoutFile
      ? null
      : 'The runtime cannot clone + write a checkout (shared stacks need a host daemon).'
  }
  return runtime.workingDir && runtime.writeCheckoutFile
    ? null
    : 'The runtime cannot create and write a working tree without a repo to clone, which this ' +
        'stack needs because every compose layer is supplied inline or read from another repo.'
}

function assertStackDefinitionValid(stack: SharedStack): void {
  const escapes = composeSourceEscapeIssues(stack.composeFiles)
  if (escapes.length > 0) {
    throw new ValidationError(escapes.join('; '), { reason: 'compose_layer_escapes_checkout' })
  }
  if (stack.cloneUrl || !composeBringUpNeedsRepo(stack)) return
  throw new ValidationError(
    'This shared stack reads committed files (a compose file path, an env-file template or a seed ' +
      'dump) but has no clone URL. Set one, or supply those compose layers inline.',
    { reason: 'clone_url_required' },
  )
}

/**
 * Lifecycle for a workspace's SHARED STACKS — long-lived compose infra a per-PR consumer
 * environment attaches to over an external network (the acme-shared-services pilot). CRUD is
 * runtime-neutral persistence (works on every facade); the bring-up (`ensureUp`) / teardown drive a
 * host Docker daemon through the injected {@link ComposeRuntime}, so they run ONLY on the local
 * facade.
 *
 * A shared stack is NEVER swept with a run and NEVER TTL-reaped — teardown is a deliberate action.
 * Unlike a per-PR preview env, its committed compose files run AS AUTHORED (host ports kept, no
 * isolation rewrite): it is the operator's own trusted infra, so the trust boundary is configuring
 * the stack, not sandboxing it. `ensureUp` is idempotent + coalesces concurrent callers onto one
 * in-flight bring-up per stack id.
 */
export class SharedStackService {
  private readonly stacks: SharedStackRepository
  private readonly workspaceRepository: WorkspaceRepository
  private readonly idGenerator: IdGenerator
  private readonly clock: Clock
  private readonly runtime: ComposeRuntime | undefined
  private readonly cloneToken: (() => string | undefined) | undefined
  private readonly runPreflightChecks:
    | ((refs: PreflightRef[]) => Promise<PreflightResult[]>)
    | undefined
  private readonly provisioningLog: ((stack: SharedStack) => RecipeStepRecorder) | undefined
  private readonly resolveRepoFiles:
    | ((
        workspaceId: string,
        coords: { owner: string; repo: string; provider?: VcsProvider },
      ) => Promise<RunRepoContext | null>)
    | undefined
  private readonly detectionConventions: DetectionConventions | undefined
  // Coalesce concurrent `ensureUp` for the same stack onto one in-flight bring-up (a second caller
  // must not start a duplicate `up` / re-run non-idempotent setup steps).
  private readonly inflight = new Map<string, Promise<SharedStack>>()
  private readonly log: Logger

  constructor(deps: SharedStackServiceDependencies) {
    this.log = (deps.logger ?? noopLogger).child({ service: 'sharedStack' })
    this.stacks = deps.sharedStackRepository
    this.workspaceRepository = deps.workspaceRepository
    this.idGenerator = deps.idGenerator
    this.clock = deps.clock
    this.runtime = deps.composeRuntime
    this.cloneToken = deps.cloneToken
    this.runPreflightChecks = deps.runPreflights
    this.provisioningLog = deps.provisioningLog
    this.resolveRepoFiles = deps.resolveRepoFilesForWorkspace
    this.detectionConventions = deps.detectionConventions
  }

  /** List a workspace's shared stacks (ordered by creation). */
  async list(workspaceId: string): Promise<SharedStack[]> {
    await requireWorkspace(this.workspaceRepository, workspaceId)
    return this.stacks.list(workspaceId)
  }

  /** A single shared stack by id. */
  async get(workspaceId: string, id: string): Promise<SharedStack> {
    await requireWorkspace(this.workspaceRepository, workspaceId)
    return assertFound(await this.stacks.get(workspaceId, id), 'SharedStack', id)
  }

  /** Create a new shared stack (initially `stopped`). */
  async create(workspaceId: string, input: CreateSharedStackInput): Promise<SharedStack> {
    await requireWorkspace(this.workspaceRepository, workspaceId)
    const now = this.clock.now()
    const stack: SharedStack = {
      id: this.idGenerator.next('ss'),
      workspaceId,
      name: input.name,
      cloneUrl: input.cloneUrl ?? null,
      gitRef: input.gitRef ?? null,
      composeFiles: input.composeFiles,
      composeProfiles: input.composeProfiles,
      envFiles: input.envFiles,
      managedNetworks: input.managedNetworks,
      setupSteps: input.setupSteps,
      prerequisites: input.prerequisites,
      healthGate: input.healthGate ?? null,
      allowHostCommands: input.allowHostCommands,
      status: 'stopped',
      lastError: null,
      createdAt: now,
      updatedAt: now,
    }
    assertStackDefinitionValid(stack)
    await this.stacks.upsert(workspaceId, stack)
    return stack
  }

  /**
   * Auto-detect a NON-BINDING recommended config for a shared stack from its repo, read
   * checkout-free over the workspace's VCS connection (no clone, no host daemon — pure repo
   * introspection). The clone URL is parsed into `{ owner, repo, provider }` coords; the workspace's
   * connection resolves a {@link RunRepoContext} the deterministic compose scan reads through.
   * Nothing is persisted — the panel prefills the create/edit form and the user confirms. Reports
   * `detected: false` (never throws) when no VCS connection is wired or the URL isn't parseable; a
   * genuine read fault (auth/rate-limit/transport) surfaces as an actionable {@link ValidationError}.
   */
  async detect(
    workspaceId: string,
    input: DetectSharedStackInput,
  ): Promise<SharedStackRecommendation> {
    await requireWorkspace(this.workspaceRepository, workspaceId)
    const empty = (message: string): SharedStackRecommendation => ({
      detected: false,
      composeFiles: [],
      composeProfiles: [],
      managedNetworks: [],
      envFiles: [],
      notes: [{ field: 'provisionType', confidence: 'low', message }],
    })

    if (!this.resolveRepoFiles) {
      return empty(
        'No VCS connection is configured for this workspace; cannot read the repo to detect the stack.',
      )
    }
    const coords = parseVcsCloneUrl(input.cloneUrl)
    if (!coords) {
      return empty(
        `Could not parse an owner/repo from the clone URL "${input.cloneUrl}". Enter the compose files manually.`,
      )
    }
    const bound = await this.resolveRepoFiles(workspaceId, coords)
    if (!bound) {
      return empty(
        `No VCS connection could read ${coords.owner}/${coords.repo}. Connect the matching provider, then retry — or enter the compose files manually.`,
      )
    }

    try {
      return await detectSharedStack(bound.repo, {
        gitRef: input.gitRef ?? bound.baseBranch,
        ...(input.directory ? { directory: input.directory } : {}),
        repoName: coords.repo,
        ...(this.detectionConventions ? { conventions: this.detectionConventions } : {}),
      })
    } catch (err) {
      if (!(err instanceof RepoReadError)) throw err
      const at = input.gitRef ? ` at "${input.gitRef}"` : ''
      throw new ValidationError(
        `Could not read ${coords.owner}/${coords.repo}${at} to auto-detect the stack. Check that the ` +
          `repo is accessible via your VCS connection, that the branch exists, and that you are not ` +
          `rate-limited, then retry. Underlying error: ${err.reason}`,
      )
    }
  }

  /** Patch a shared stack's config. A running stack cannot be reconfigured — tear it down first. */
  async update(
    workspaceId: string,
    id: string,
    patch: UpdateSharedStackInput,
  ): Promise<SharedStack> {
    await requireWorkspace(this.workspaceRepository, workspaceId)
    const existing = assertFound(await this.stacks.get(workspaceId, id), 'SharedStack', id)
    if (existing.status === 'running' || existing.status === 'starting') {
      throw new ConflictError('Tear the shared stack down before reconfiguring it.')
    }
    const updated: SharedStack = {
      ...existing,
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.cloneUrl !== undefined ? { cloneUrl: patch.cloneUrl } : {}),
      ...(patch.gitRef !== undefined ? { gitRef: patch.gitRef } : {}),
      ...(patch.composeFiles !== undefined ? { composeFiles: patch.composeFiles } : {}),
      ...(patch.composeProfiles !== undefined ? { composeProfiles: patch.composeProfiles } : {}),
      ...(patch.envFiles !== undefined ? { envFiles: patch.envFiles } : {}),
      ...(patch.managedNetworks !== undefined ? { managedNetworks: patch.managedNetworks } : {}),
      ...(patch.setupSteps !== undefined ? { setupSteps: patch.setupSteps } : {}),
      ...(patch.prerequisites !== undefined ? { prerequisites: patch.prerequisites } : {}),
      ...(patch.healthGate !== undefined ? { healthGate: patch.healthGate } : {}),
      ...(patch.allowHostCommands !== undefined
        ? { allowHostCommands: patch.allowHostCommands }
        : {}),
      updatedAt: this.clock.now(),
    }
    // Validate the MERGED entity, not the patch: `composeFiles` and `cloneUrl` are patched
    // independently, so dropping the clone URL and adding a `path` layer are each individually
    // innocent and only conflict once combined.
    assertStackDefinitionValid(updated)
    await this.stacks.upsert(workspaceId, updated)
    return updated
  }

  /** Remove a shared stack. A running stack must be torn down first (never silently killed). */
  async remove(workspaceId: string, id: string): Promise<void> {
    await requireWorkspace(this.workspaceRepository, workspaceId)
    const existing = await this.stacks.get(workspaceId, id)
    if (existing && (existing.status === 'running' || existing.status === 'starting')) {
      throw new ConflictError('Tear the shared stack down before deleting it.')
    }
    await this.stacks.remove(workspaceId, id)
  }

  /**
   * Bring a shared stack up (idempotent). Already-`running` ⇒ a no-op returning the record.
   * Otherwise: clone/refresh the repo, create its managed networks, `up -d` under its profiles,
   * materialize env-file templates, run the ordered setup steps, then poll the terminal health gate
   * — persisting `running` / `failed` (+ `lastError`) at the end. Concurrent callers coalesce onto
   * one in-flight bring-up. Requires the host Docker runtime (local facade).
   */
  async ensureUp(workspaceId: string, id: string): Promise<SharedStack> {
    await requireWorkspace(this.workspaceRepository, workspaceId)
    const stack = assertFound(await this.stacks.get(workspaceId, id), 'SharedStack', id)
    return this.ensureStackUp(workspaceId, stack)
  }

  /**
   * Bring an ALREADY-RESOLVED shared stack up (idempotent). Split out of {@link ensureUp} so a batch
   * caller ({@link ensureRefsUp}) can drive several stacks after a SINGLE list read — no repository
   * point-read per stack. Requires the host Docker runtime; coalesces concurrent callers per stack id.
   */
  private async ensureStackUp(workspaceId: string, stack: SharedStack): Promise<SharedStack> {
    if (!this.runtime) {
      throw new ValidationError(
        'Bringing a shared stack up requires the local Docker runtime (unavailable on this deployment).',
      )
    }
    // Idempotent no-op ONLY when the daemon actually still has the stack up. The stored `running`
    // is intent, not liveness — after a host reboot / `docker system prune` the row still says
    // `running` while nothing is up, so trust-but-verify with a cheap `compose ps` before
    // short-circuiting; a stale `running` falls through and re-provisions instead of wedging.
    if (stack.status === 'running' && (await this.isStackLive(stack))) return stack
    const existing = this.inflight.get(stack.id)
    if (existing) return existing
    const run = this.bringUp(workspaceId, stack).finally(() => this.inflight.delete(stack.id))
    this.inflight.set(stack.id, run)
    return run
  }

  /**
   * Bring UP the shared stacks a consumer recipe references (`recipe.sharedStackRefs`) and return
   * the deduped union of the managed Docker networks they own — the provider-before-consumer step
   * the compose environment provider runs before standing a per-PR project up, so it can attach to
   * those networks as `external: true`. The workspace's stacks are read ONCE (batched, then indexed
   * by id — no point-read per ref) and each referenced stack is ensured idempotently (a healthy stack
   * is a no-op) IN ORDER, since a later stack may depend on an earlier one's network. Returns a
   * blocking `error` — never throws — when a ref names no stack in the workspace, the runtime can't
   * bring one up (no host daemon), or a bring-up fails, so the provider surfaces a deterministic
   * provision failure with the real cause. This is the
   * {@link ProvisionEnvironmentRequest.ensureSharedStacks} seam's implementation.
   */
  async ensureRefsUp(workspaceId: string, refs: string[]): Promise<SharedStackEnsureResult> {
    await requireWorkspace(this.workspaceRepository, workspaceId)
    // Batch-load the workspace's stacks once and index by id, so the ordered bring-up below does
    // host-daemon work only — never a repository round-trip per ref (no N+1).
    const byId = new Map((await this.stacks.list(workspaceId)).map((stack) => [stack.id, stack]))
    const networks: string[] = []
    const seen = new Set<string>()
    for (const ref of refs) {
      const found = byId.get(ref)
      if (!found) return { ok: false, error: `shared stack '${ref}': not found in this workspace` }
      let stack: SharedStack
      try {
        stack = await this.ensureStackUp(workspaceId, found)
      } catch (err) {
        // A runtime that can't bring stacks up (no daemon) or an unexpected bring-up throw becomes a
        // clear blocking reason for the provision.
        return { ok: false, error: `shared stack '${ref}': ${getErrorMessage(err)}` }
      }
      if (stack.status !== 'running') {
        // `ensureUp` persists (and returns) a `failed` stack rather than throwing; surface its
        // lastError so the consumer's provisioning log shows why the shared infra didn't come up.
        return {
          ok: false,
          error: `shared stack '${stack.name}' is not running: ${
            stack.lastError ?? 'bring-up did not complete'
          }`,
        }
      }
      for (const network of stack.managedNetworks) {
        if (!seen.has(network)) {
          seen.add(network)
          networks.push(network)
        }
      }
    }
    return { ok: true, networks }
  }

  /** Tear a shared stack down (`down -v`). A deliberate action; the stack row is preserved. */
  async teardown(workspaceId: string, id: string): Promise<SharedStack> {
    await requireWorkspace(this.workspaceRepository, workspaceId)
    const stack = assertFound(await this.stacks.get(workspaceId, id), 'SharedStack', id)
    const runtime = this.runtime
    if (!runtime) {
      throw new ValidationError(
        'Tearing a shared stack down requires the local Docker runtime (unavailable on this deployment).',
      )
    }
    const project = this.projectName(stack)
    // A `down` that fails still flips the row to `stopped` (the operator asked for it), so the
    // failure has no other symptom than containers that outlive the stack they belong to.
    await runBestEffort(
      this.log,
      'sharedStack.composeDown',
      () =>
        runtime.compose(['-p', project, 'down', '-v', '--remove-orphans'], {
          timeoutMs: SHORT_TIMEOUT_MS,
        }),
      { workspaceId, stackId: id, project },
    )
    await runtime.cleanupProject?.(project)
    return this.persist(workspaceId, stack, { status: 'stopped', lastError: null })
  }

  // --- internals ----------------------------------------------------------

  /** The stable compose project name for a shared stack (long-lived, NOT per-PR). */
  private projectName(stack: SharedStack): string {
    return `cf-stack-${stack.id}`
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-')
      .slice(0, 63)
  }

  /**
   * Is the stack's compose project ACTUALLY up on the daemon right now? A project-name-scoped
   * `compose ps` (no checkout / `-f` needed) classified as `ready`. Used to reconcile a stored
   * `running` against reality before `ensureUp` short-circuits — a failed probe (daemon gone,
   * containers pruned) reads as not-live so the caller re-provisions. Never throws.
   */
  private async isStackLive(stack: SharedStack): Promise<boolean> {
    const runtime = this.runtime
    if (!runtime) return false
    const ps = await runtime
      .compose(['-p', this.projectName(stack), 'ps', '-a', '--format', 'json'], {
        timeoutMs: SHORT_TIMEOUT_MS,
      })
      .catch(() => null)
    if (!ps || ps.code !== 0) return false
    return classifyComposePs(ps.stdout) === 'ready'
  }

  /** Drive the full bring-up, persisting the terminal `running`/`failed` verdict. */
  private async bringUp(workspaceId: string, stack: SharedStack): Promise<SharedStack> {
    const runtime = this.runtime!
    const record = this.provisioningLog?.(stack)
    await this.persist(workspaceId, stack, { status: 'starting', lastError: null })
    const project = this.projectName(stack)

    // Machine-prerequisite checks FIRST — before the clone / networks / `up` — so a stale ECR
    // token / missing mkcert CA / missing hosts entry fails fast with copy-paste remediation
    // instead of a mystery deep inside a 40-image pull.
    const preflightIssue = await this.runPreflights(stack, record)
    if (preflightIssue) {
      return this.persist(workspaceId, stack, { status: 'failed', lastError: preflightIssue })
    }

    // Gate on the seams THIS stack actually uses, not on a fixed set: a stack declared entirely in
    // code reads no committed file, so refusing it for want of a clone seam it never calls would
    // make the repo-less shape unreachable on a runtime that can serve it perfectly well. Both
    // shapes still need to WRITE (the materialized layers / the rewritten env files).
    const capabilityIssue = missingRuntimeCapability(runtime, stack)
    if (capabilityIssue) {
      return this.persist(workspaceId, stack, { status: 'failed', lastError: capabilityIssue })
    }

    // A `host-command` setup step is refused unless the stack opted in AND the runtime supports it.
    const hostCmdIssue = this.checkHostCommands(stack)
    if (hostCmdIssue) {
      return this.persist(workspaceId, stack, { status: 'failed', lastError: hostCmdIssue })
    }

    // Resolve the compose layers and get the working tree they run out of — a clone for a stack
    // with committed files, an empty materialized tree for one declared entirely inline.
    const tree = await this.prepareWorkingTree(workspaceId, stack, runtime, project, record)
    if ('error' in tree) {
      return this.persist(workspaceId, stack, { status: 'failed', lastError: tree.error })
    }
    const { checkoutDir, planned } = tree

    // Create the managed networks the stack owns (its consumers attach to these as external).
    const networkIssue = await this.createManagedNetworks(stack, runtime, record)
    if (networkIssue) {
      return this.persist(workspaceId, stack, { status: 'failed', lastError: networkIssue })
    }

    // Materialize env-file templates BEFORE `up`, each a logged step.
    const envFileIssue = await this.materializeEnvFiles(stack, runtime, project, record)
    if (envFileIssue) {
      return this.persist(workspaceId, stack, { status: 'failed', lastError: envFileIssue })
    }

    // The stack runs its committed compose files AS AUTHORED (host ports kept — it is trusted infra,
    // not an isolated per-PR preview). `--project-directory` is the first IN-REPO layer's dir so its
    // relative build contexts / binds / env_files resolve as written; a materialized layer never
    // moves that anchor.
    const projectDir = planned.projectDir ? `${checkoutDir}/${planned.projectDir}` : checkoutDir
    const files = planned.layers.flatMap((layer) => ['-f', `${checkoutDir}/${layer.path}`])
    const scope = ['-p', project, '--project-directory', projectDir, ...files]
    const env: Record<string, string> = stack.composeProfiles.length
      ? { COMPOSE_PROFILES: stack.composeProfiles.join(',') }
      : {}

    const upStarted = this.clock.now()
    const up = await runtime.compose([...scope, 'up', '-d'], { env, timeoutMs: UP_TIMEOUT_MS })
    const upOk = up.code === 0
    await this.logStep(record, 'compose up', upStarted, {
      ok: upOk,
      ...(upOk ? {} : { error: tailOutput(up.stderr || up.stdout) }),
    })
    if (!upOk) {
      return this.persist(workspaceId, stack, {
        status: 'failed',
        lastError: tailOutput(up.stderr || up.stdout) || 'docker compose up failed',
      })
    }

    // Ordered setup steps (users sync, connector registration, seed import, …).
    const setupIssue = await this.runSetupSteps(stack, runtime, scope, env, project, record)
    if (setupIssue) {
      return this.persist(workspaceId, stack, { status: 'failed', lastError: setupIssue })
    }

    // Terminal health gate.
    const gateIssue = await this.runTerminalHealthGate(stack, runtime, scope, env, record)
    if (gateIssue) {
      return this.persist(workspaceId, stack, { status: 'failed', lastError: gateIssue })
    }

    return this.persist(workspaceId, stack, { status: 'running', lastError: null })
  }

  /**
   * Create the managed networks the stack owns (its consumers attach to these as external),
   * streaming one provisioning-log step per network. Returns a blocking `lastError` on the first
   * failure, else null.
   */
  private async createManagedNetworks(
    stack: SharedStack,
    runtime: ComposeRuntime,
    record: RecipeStepRecorder | undefined,
  ): Promise<string | null> {
    for (const network of stack.managedNetworks) {
      const started = this.clock.now()
      const res = (await runtime.ensureNetwork?.(network)) ?? {
        code: 1,
        stdout: '',
        stderr: 'runtime cannot manage networks',
      }
      const ok = res.code === 0
      await this.logStep(record, `network: ${network}`, started, {
        ok,
        ...(ok ? {} : { error: tailOutput(res.stderr || res.stdout) || `exit ${res.code}` }),
      })
      if (!ok) {
        return `Could not create network '${network}': ${tailOutput(res.stderr || res.stdout)}`
      }
    }
    return null
  }

  /**
   * Resolve the ordered `-f` layers and materialize the working tree they run out of, returning the
   * checkout dir + the plan (or a blocking `error` for the caller to persist). Split out of
   * {@link bringUp} because it is the one phase whose shape depends on WHERE the layers come from:
   *
   * - layers are planned FIRST, before any daemon work, so an unreadable inline/foreign layer fails
   *   with its own cause instead of surfacing as a missing file at `up` time;
   * - a stack with nothing committed to read (every layer inline / from another repo, no env-file
   *   templates, no seed dumps) needs no clone at all — the shape a deployment declares in code —
   *   and gets an empty materialized tree instead. Anything that DOES read a committed file needs a
   *   clone URL, and saying so here beats cloning nothing and failing later as a missing path.
   */
  private async prepareWorkingTree(
    workspaceId: string,
    stack: SharedStack,
    runtime: ComposeRuntime,
    project: string,
    record: RecipeStepRecorder | undefined,
  ): Promise<{ checkoutDir: string; planned: ComposeLayerPlanResult } | { error: string }> {
    const planned = await planComposeLayers(
      stack.composeFiles,
      this.resolveRepoFiles
        ? { resolveForeignRepo: (coords) => this.resolveRepoFiles!(workspaceId, coords) }
        : {},
    )
    if ('error' in planned) return planned

    if (composeBringUpNeedsRepo(stack) && !stack.cloneUrl) {
      return {
        error:
          'This stack reads committed files (a compose file path, an env-file template or a seed ' +
          'dump) but has no clone URL. Set one, or supply those layers inline.',
      }
    }

    const started = this.clock.now()
    const label = stack.cloneUrl ? 'clone repo' : 'working tree'
    let checkoutDir: string
    try {
      // Both seams are optional on the port and are read TOTALLY here rather than asserted: the
      // capability gate in `bringUp` has already refused a runtime missing the one this shape
      // needs, so an absent seam at this point is a wiring bug, and it should say so instead of
      // surfacing as a `TypeError` on an `undefined` call.
      const cloneToken = this.cloneToken?.()
      const tree = stack.cloneUrl
        ? await runtime.checkout?.(project, {
            cloneUrl: stack.cloneUrl,
            ref: stack.gitRef ?? 'HEAD',
            ...(cloneToken ? { token: cloneToken } : {}),
          })
        : await runtime.workingDir?.(project)
      if (!tree) {
        throw new Error(
          stack.cloneUrl
            ? 'the runtime cannot clone a repo'
            : 'the runtime cannot create a working tree without a repo to clone',
        )
      }
      checkoutDir = tree.dir
      await this.logStep(record, label, started, { ok: true })
    } catch (err) {
      // Scrubbed: `cloneToken` is threaded into `checkout`, so a failing git invocation can echo
      // the tokenized remote URL straight into a `lastError` the SPA renders.
      const message =
        redactSecrets(`Could not prepare the stack working tree: ${getErrorMessage(err)}`) ?? ''
      await this.logStep(record, label, started, { ok: false, error: message })
      return { error: message }
    }

    // Write the inline / foreign layers into the tree, each a logged step.
    const layerIssue = await this.materializeComposeLayers(planned.layers, runtime, project, record)
    if (layerIssue) return { error: layerIssue }
    return { checkoutDir, planned }
  }

  /**
   * Write the planned `inline` / `repo` compose layers into the working tree, each a logged step.
   * A `path` layer carries no content and is skipped — it already sits in the clone, where the
   * stack runs it as authored. Returns a blocking `lastError` on the first failure, else null.
   */
  private async materializeComposeLayers(
    layers: ComposeLayerPlan[],
    runtime: ComposeRuntime,
    project: string,
    record: RecipeStepRecorder | undefined,
  ): Promise<string | null> {
    for (const layer of layers) {
      if (layer.content === undefined) continue
      const label = `compose layer: ${describeComposeSource(layer.source)}`
      const started = this.clock.now()
      try {
        // Checked per LAYER, not up front: a stack of plain in-repo paths never materializes
        // anything, so a runtime lacking this seam must still be able to bring one up.
        if (!runtime.writeCheckoutFile) {
          throw new Error('the runtime cannot write into a checkout')
        }
        await runtime.writeCheckoutFile(project, layer.path, layer.content)
        await this.logStep(record, label, started, { ok: true })
      } catch (err) {
        const message = `Could not write compose layer '${layer.path}': ${err instanceof Error ? err.message : String(err)}`
        await this.logStep(record, label, started, { ok: false, error: message })
        return message
      }
    }
    return null
  }

  /**
   * Materialize the stack's env-file templates BEFORE `up`, each a logged step. Returns a blocking
   * `lastError` on the first failure, else null.
   */
  private async materializeEnvFiles(
    stack: SharedStack,
    runtime: ComposeRuntime,
    project: string,
    record: RecipeStepRecorder | undefined,
  ): Promise<string | null> {
    for (const envFile of stack.envFiles) {
      const started = this.clock.now()
      try {
        await runtime.copyCheckoutFile!(project, envFile.template, envFile.target)
        await this.logStep(record, `env-file: ${envFile.target}`, started, { ok: true })
      } catch (err) {
        const message = `Could not materialize env file '${envFile.target}': ${err instanceof Error ? err.message : String(err)}`
        await this.logStep(record, `env-file: ${envFile.target}`, started, {
          ok: false,
          error: message,
        })
        return message
      }
    }
    return null
  }

  /**
   * Run the stack's ordered setup steps (users sync, connector registration, seed import, …), each
   * a logged step. Returns a blocking `lastError` on the first failure, else null.
   */
  private async runSetupSteps(
    stack: SharedStack,
    runtime: ComposeRuntime,
    scope: string[],
    env: Record<string, string>,
    project: string,
    record: RecipeStepRecorder | undefined,
  ): Promise<string | null> {
    for (const step of stack.setupSteps) {
      const started = this.clock.now()
      const result = await runRecipeStep(step, { runtime, scope, env, project })
      await this.logStep(record, step.name, started, result)
      if (!result.ok) {
        return `Setup step '${step.name}' failed: ${result.error}`
      }
    }
    return null
  }

  /**
   * Run the stack's terminal health gate (its declared gate, else the recipe default), logging the
   * step. Returns a blocking `lastError` when it doesn't pass, else null.
   */
  private async runTerminalHealthGate(
    stack: SharedStack,
    runtime: ComposeRuntime,
    scope: string[],
    env: Record<string, string>,
    record: RecipeStepRecorder | undefined,
  ): Promise<string | null> {
    const gate = stack.healthGate ?? DEFAULT_RECIPE_HEALTH_GATE
    const gateStarted = this.clock.now()
    const gateResult = await runHealthGate(gate, { runtime, scope, env }, SHORT_TIMEOUT_MS)
    await this.logStep(record, `health gate (${gate.kind})`, gateStarted, gateResult)
    if (!gateResult.ok) {
      return `Health gate did not pass: ${gateResult.error}`
    }
    return null
  }

  /**
   * Re-run the stack's declared machine-prerequisite checks (`prerequisites`) at bring-up start,
   * streaming one provisioning-log step per check, and return a blocking message when any REQUIRED
   * check fails (with its detail + remediation) — else null. No declared prerequisites ⇒ a no-op. A
   * stack that DECLARES prerequisites on a deployment where the host-probe runtime isn't wired
   * (`runPreflightChecks` absent — no host daemon) fails loudly rather than silently skipping a
   * declared safety gate, mirroring the compose provider's `runPreflights` seam.
   */
  private async runPreflights(
    stack: SharedStack,
    record: RecipeStepRecorder | undefined,
  ): Promise<string | null> {
    const refs = stack.prerequisites
    if (refs.length === 0) return null
    if (!this.runPreflightChecks) {
      return 'This shared stack declares preflight prerequisite check(s), but preflight checks are not available on this deployment (they need a host Docker daemon).'
    }
    const started = this.clock.now()
    const results = await this.runPreflightChecks(refs)
    // Stream each check as its own provisioning-log entry (a `warn` is advisory — a success note).
    for (const r of results) {
      await this.logStep(record, `preflight: ${r.title}`, started, {
        ok: r.status !== 'fail',
        ...(r.detail ? { detail: r.status === 'warn' ? `warn: ${r.detail}` : r.detail } : {}),
        ...(r.status === 'fail' ? { error: r.detail ?? 'failed' } : {}),
      })
    }
    const blocking = preflightBlockingFailures(results)
    return blocking.length > 0 ? formatPreflightFailure(blocking) : null
  }

  /**
   * Refuse a stack's `host-command` setup steps unless it opted in (`allowHostCommands`) AND the
   * runtime can run host commands. Returns a blocking message, or null when allowed / none declared.
   */
  private checkHostCommands(stack: SharedStack): string | null {
    if (!stack.setupSteps.some((s) => s.kind === 'host-command')) return null
    if (!stack.allowHostCommands) {
      return "This stack declares host-command step(s), but host commands are not enabled for it (set 'Allow host commands')."
    }
    if (!this.runtime?.hostCommand) {
      return 'This stack declares host-command step(s), but the runtime cannot run host commands.'
    }
    return null
  }

  /** Write a stack's lifecycle transition (status + lastError, bumping updatedAt) and return it. */
  private async persist(
    workspaceId: string,
    stack: SharedStack,
    change: { status: SharedStack['status']; lastError: string | null },
  ): Promise<SharedStack> {
    const updated: SharedStack = {
      ...stack,
      status: change.status,
      lastError: change.lastError,
      updatedAt: this.clock.now(),
    }
    await this.stacks.upsert(workspaceId, updated)
    return updated
  }

  /** Best-effort per-step provisioning-log entry (never throws; no-op when no recorder is wired). */
  private async logStep(
    record: RecipeStepRecorder | undefined,
    name: string,
    startedAt: number,
    result: { ok: boolean; detail?: string; error?: string },
  ): Promise<void> {
    if (!record) return
    try {
      await record({
        name,
        outcome: result.ok ? 'success' : 'failure',
        durationMs: this.clock.now() - startedAt,
        ...(result.detail ? { detail: result.detail } : {}),
        ...(result.error ? { error: result.error } : {}),
      })
    } catch {
      // best-effort: a log-write failure must never break the bring-up.
    }
  }
}
