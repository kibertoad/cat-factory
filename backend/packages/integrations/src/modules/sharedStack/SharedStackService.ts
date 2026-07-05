import type {
  Clock,
  CreateSharedStackInput,
  IdGenerator,
  RecipeStepRecorder,
  SharedStack,
  SharedStackEnsureResult,
  SharedStackRepository,
  UpdateSharedStackInput,
  WorkspaceRepository,
} from '@cat-factory/kernel'
import {
  assertFound,
  ConflictError,
  getErrorMessage,
  requireWorkspace,
  ValidationError,
} from '@cat-factory/kernel'
import {
  type ComposeRuntime,
  classifyComposePs,
  composeFileDir,
  DEFAULT_RECIPE_HEALTH_GATE,
  tailOutput,
} from '../compose/compose-environment.logic.js'
import { runHealthGate, runRecipeStep } from '../compose/recipe-runner.js'

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
   * Absent ⇒ the clone runs unauthenticated (public repos only), exactly as before.
   */
  cloneToken?: string
  /**
   * Optional per-step provisioning-log recorder factory: given a stack, returns a recorder the
   * bring-up streams per-step verdicts through (clone, network, env-file, up, each setup step,
   * health gate), so the Infrastructure "View logs" drawer shows which step ran/died. Absent ⇒ no
   * per-step logging (the status/lastError on the record are still updated).
   */
  provisioningLog?: (stack: SharedStack) => RecipeStepRecorder
}

// Bound (ms) for the plain compose calls (network / down / version) so a wedged daemon can't hang
// a bring-up/teardown forever; `up` clears its own health-gate budget separately.
const SHORT_TIMEOUT_MS = 60_000
const UP_TIMEOUT_MS = 330_000

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
  private readonly cloneToken: string | undefined
  private readonly provisioningLog: ((stack: SharedStack) => RecipeStepRecorder) | undefined
  // Coalesce concurrent `ensureUp` for the same stack onto one in-flight bring-up (a second caller
  // must not start a duplicate `up` / re-run non-idempotent setup steps).
  private readonly inflight = new Map<string, Promise<SharedStack>>()

  constructor(deps: SharedStackServiceDependencies) {
    this.stacks = deps.sharedStackRepository
    this.workspaceRepository = deps.workspaceRepository
    this.idGenerator = deps.idGenerator
    this.clock = deps.clock
    this.runtime = deps.composeRuntime
    this.cloneToken = deps.cloneToken
    this.provisioningLog = deps.provisioningLog
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
      cloneUrl: input.cloneUrl,
      gitRef: input.gitRef ?? null,
      composeFiles: input.composeFiles,
      composeProfiles: input.composeProfiles,
      envFiles: input.envFiles,
      managedNetworks: input.managedNetworks,
      setupSteps: input.setupSteps,
      healthGate: input.healthGate ?? null,
      allowHostCommands: input.allowHostCommands,
      status: 'stopped',
      lastError: null,
      createdAt: now,
      updatedAt: now,
    }
    await this.stacks.upsert(workspaceId, stack)
    return stack
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
      ...(patch.healthGate !== undefined ? { healthGate: patch.healthGate } : {}),
      ...(patch.allowHostCommands !== undefined
        ? { allowHostCommands: patch.allowHostCommands }
        : {}),
      updatedAt: this.clock.now(),
    }
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
    const existing = this.inflight.get(id)
    if (existing) return existing
    const run = this.bringUp(workspaceId, stack).finally(() => this.inflight.delete(id))
    this.inflight.set(id, run)
    return run
  }

  /**
   * Bring UP the shared stacks a consumer recipe references (`recipe.sharedStackRefs`) and return
   * the deduped union of the managed Docker networks they own — the provider-before-consumer step
   * the compose environment provider runs before standing a per-PR project up, so it can attach to
   * those networks as `external: true`. Each ref is ensured idempotently (a healthy stack is a
   * no-op) IN ORDER, since a later stack may depend on an earlier one's network. Returns a blocking
   * `error` — never throws — when a ref names no stack in the workspace, the runtime can't bring one
   * up (no host daemon), or a bring-up fails, so the provider surfaces a deterministic provision
   * failure with the real cause. This is the {@link ProvisionEnvironmentRequest.ensureSharedStacks}
   * seam's implementation.
   */
  async ensureRefsUp(workspaceId: string, refs: string[]): Promise<SharedStackEnsureResult> {
    const networks: string[] = []
    const seen = new Set<string>()
    for (const ref of refs) {
      let stack: SharedStack
      try {
        stack = await this.ensureUp(workspaceId, ref)
      } catch (err) {
        // A missing ref (assertFound), a runtime that can't bring stacks up (no daemon), or a
        // workspace-guard miss — all become a clear blocking reason for the provision.
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
    if (!this.runtime) {
      throw new ValidationError(
        'Tearing a shared stack down requires the local Docker runtime (unavailable on this deployment).',
      )
    }
    const project = this.projectName(stack)
    await this.runtime
      .compose(['-p', project, 'down', '-v', '--remove-orphans'], { timeoutMs: SHORT_TIMEOUT_MS })
      .catch(() => {})
    await this.runtime.cleanupProject?.(project)
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

    if (!runtime.checkout || !runtime.copyCheckoutFile) {
      return this.persist(workspaceId, stack, {
        status: 'failed',
        lastError:
          'The runtime cannot clone + write a checkout (shared stacks need a host daemon).',
      })
    }

    // A `host-command` setup step is refused unless the stack opted in AND the runtime supports it.
    const hostCmdIssue = this.checkHostCommands(stack)
    if (hostCmdIssue) {
      return this.persist(workspaceId, stack, { status: 'failed', lastError: hostCmdIssue })
    }

    // Clone/refresh the stack repo into its own long-lived working tree.
    const cloneStarted = this.clock.now()
    let checkoutDir: string
    try {
      ;({ dir: checkoutDir } = await runtime.checkout(project, {
        cloneUrl: stack.cloneUrl,
        ref: stack.gitRef ?? 'HEAD',
        ...(this.cloneToken ? { token: this.cloneToken } : {}),
      }))
      await this.logStep(record, 'clone repo', cloneStarted, { ok: true })
    } catch (err) {
      const message = `Could not clone the stack repo: ${err instanceof Error ? err.message : String(err)}`
      await this.logStep(record, 'clone repo', cloneStarted, { ok: false, error: message })
      return this.persist(workspaceId, stack, { status: 'failed', lastError: message })
    }

    // Create the managed networks the stack owns (its consumers attach to these as external).
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
        return this.persist(workspaceId, stack, {
          status: 'failed',
          lastError: `Could not create network '${network}': ${tailOutput(res.stderr || res.stdout)}`,
        })
      }
    }

    // Materialize env-file templates BEFORE `up`, each a logged step.
    for (const envFile of stack.envFiles) {
      const started = this.clock.now()
      try {
        await runtime.copyCheckoutFile(project, envFile.template, envFile.target)
        await this.logStep(record, `env-file: ${envFile.target}`, started, { ok: true })
      } catch (err) {
        const message = `Could not materialize env file '${envFile.target}': ${err instanceof Error ? err.message : String(err)}`
        await this.logStep(record, `env-file: ${envFile.target}`, started, {
          ok: false,
          error: message,
        })
        return this.persist(workspaceId, stack, { status: 'failed', lastError: message })
      }
    }

    // The stack runs its committed compose files AS AUTHORED (host ports kept — it is trusted infra,
    // not an isolated per-PR preview). `--project-directory` is the first file's dir so its relative
    // build contexts / binds / env_files resolve as written.
    const composeDir = composeFileDir(stack.composeFiles[0]!)
    const projectDir = composeDir ? `${checkoutDir}/${composeDir}` : checkoutDir
    const files = stack.composeFiles.flatMap((f) => ['-f', `${checkoutDir}/${f}`])
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
    for (const step of stack.setupSteps) {
      const started = this.clock.now()
      const result = await runRecipeStep(step, { runtime, scope, env, project })
      await this.logStep(record, step.name, started, result)
      if (!result.ok) {
        return this.persist(workspaceId, stack, {
          status: 'failed',
          lastError: `Setup step '${step.name}' failed: ${result.error}`,
        })
      }
    }

    // Terminal health gate.
    const gate = stack.healthGate ?? DEFAULT_RECIPE_HEALTH_GATE
    const gateStarted = this.clock.now()
    const gateResult = await runHealthGate(gate, { runtime, scope, env }, SHORT_TIMEOUT_MS)
    await this.logStep(record, `health gate (${gate.kind})`, gateStarted, gateResult)
    if (!gateResult.ok) {
      return this.persist(workspaceId, stack, {
        status: 'failed',
        lastError: `Health gate did not pass: ${gateResult.error}`,
      })
    }

    return this.persist(workspaceId, stack, { status: 'running', lastError: null })
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
