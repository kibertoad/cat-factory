import {
  createWorkspaceContract,
  deleteWorkspaceContract,
  getWorkspaceContract,
  listWorkspacesContract,
  updateWorkspaceContract,
} from '@cat-factory/contracts'
import { configContributionCatalog } from '@cat-factory/agents'
import { initiativePresetDescriptors } from '@cat-factory/kernel'
import { buildHonoRoute } from '@toad-contracts/hono'
import { Hono } from 'hono'
import { logger as sharedLogger } from '../../observability/logger.js'
import type { EnvironmentBackendRegistry, RunnerBackendRegistry } from '@cat-factory/integrations'
import type {
  BackendKindOption,
  BudgetCaps,
  CustomAgentKind,
  InfraSetup,
  SpendStatus,
  UserSettings,
  WorkspaceSnapshot,
} from '@cat-factory/contracts'
import type { AgentKindRegistry, AgentRouting } from '@cat-factory/agents'
import type { ModelRef } from '@cat-factory/kernel'
import type { ServerContainer } from '../../http/env.js'

/**
 * Assemble the account- and user-tier spend widgets for a snapshot: the account-tier
 * status (across the owning account's workspaces), the signed-in caller's user-tier
 * status + editable settings, and the operator hard caps. Shared by the GET snapshot and
 * the POST-create response so the two can't drift on which tier fields they carry.
 *
 * The caller's `user_settings` row is read ONCE and its configured limit fed into
 * `userStatus`, so the user tier isn't read twice. Each tier's status read is best-effort:
 * an optional budget widget must never 500 the whole board load, so a read failure (e.g. a
 * scope-denied persistence RPC in a misconfigured mothership) degrades that tier to absent.
 */
async function assembleBudgetTiers(
  container: ServerContainer,
  opts: { accountId: string | null | undefined; viewerUserId: string | undefined },
): Promise<{
  accountSpend?: SpendStatus
  userSpend?: SpendStatus
  userSettings?: UserSettings
  budgetCaps: BudgetCaps
}> {
  const { accountId, viewerUserId } = opts
  const viewerUserSettings =
    viewerUserId && container.userSettings
      ? await container.userSettings.service.get(viewerUserId).catch(() => undefined)
      : undefined
  const [accountSpend, userSpend] = await Promise.all([
    accountId
      ? container.spendService.accountStatus(accountId).catch(() => null)
      : Promise.resolve(null),
    viewerUserId
      ? container.spendService
          .userStatus(
            viewerUserId,
            viewerUserSettings
              ? { configuredLimit: viewerUserSettings.spendMonthlyLimit }
              : undefined,
          )
          .catch(() => null)
      : Promise.resolve(null),
  ])
  return {
    ...(accountSpend ? { accountSpend } : {}),
    ...(userSpend ? { userSpend } : {}),
    ...(viewerUserSettings ? { userSettings: viewerUserSettings } : {}),
    budgetCaps: container.spendService.budgetCaps(),
  }
}

/**
 * The agent config-contribution catalog for a snapshot: the descriptors contributed
 * across every agent kind used by the workspace's pipelines (deduped by id). Static
 * metadata derived from the agent registry; the board renders the subset whose
 * owning kind appears in a task's selected pipeline.
 */
function snapshotAgentConfigCatalog(snapshot: WorkspaceSnapshot, registry: AgentKindRegistry) {
  const kinds = new Set<string>()
  for (const pipeline of snapshot.pipelines) for (const kind of pipeline.agentKinds) kinds.add(kind)
  return configContributionCatalog(kinds, registry)
}

/**
 * The deployment's env-routing defaults as `provider:model` ref strings, so the
 * model-defaults panel can name the model behind "Deployment default" per kind.
 * Derived from the shared agents config, so identical across facades.
 */
/**
 * The registered CUSTOM agent kinds carrying frontend presentation metadata, mapped to
 * the wire shape the SPA merges into its palette catalog. Only kinds that declared a
 * `presentation` become first-class palette blocks; the rest stay engine-internal. Static
 * (process-global registry), so identical for every workspace and every facade. Returns
 * undefined when none are registered, so the field is simply absent on the stock product.
 */
function snapshotCustomAgentKinds(registry: AgentKindRegistry): CustomAgentKind[] | undefined {
  const kinds = registry
    .all()
    .filter((def) => def.presentation)
    .map((def) => ({
      kind: def.kind,
      presentation: def.presentation!,
      container: registry.requiresContainer(def.kind),
    }))
  return kinds.length > 0 ? kinds : undefined
}

/**
 * The registered ephemeral-environment / runner-pool backend kinds (built-in + any a
 * deployment registered into the app-owned registries), as the `{ kind, label }` options the
 * SPA drives its provider-connect backend selector from. Read off the request container's
 * injected registries (built here, not in the shared `WorkspaceService.snapshot()`, because
 * the registries live in `@cat-factory/integrations`, which the `workspaces` package doesn't
 * depend on).
 */
function snapshotBackendKinds(registries: {
  environmentBackendRegistry: EnvironmentBackendRegistry
  runnerBackendRegistry: RunnerBackendRegistry
}): {
  environmentBackendKinds: BackendKindOption[]
  runnerBackendKinds: BackendKindOption[]
} {
  return {
    environmentBackendKinds: registries.environmentBackendRegistry.labelled(),
    runnerBackendKinds: registries.runnerBackendRegistry.labelled(),
  }
}

/**
 * The per-area infrastructure-setup status for a workspace, computed from whatever THIS
 * deployment actually wired (so it's runtime-symmetric by construction — the shared controller
 * derives it, no per-facade code). Each area is:
 *  - `not_applicable` — the integration isn't wired for this runtime (nothing to configure), so
 *    the read function is absent. The runner-pool executor counts as an area ONLY when the pool is
 *    the sole way container agents run (`agentExecutorRequiresRunnerPool`) — remote/stock Node;
 *    Cloudflare (built-in per-run containers) and local mode (per-run host containers) both wire the
 *    runner surface but keep a built-in executor, so the pool is optional there ⇒ `not_applicable`.
 *    Binary storage is `not_applicable` only when the facade wired no artifact-store resolver at all — in practice
 *    every facade wires one, so this area is `configured`/`not_defined` everywhere: a Cloudflare
 *    deployment without an `ARTIFACT_BUCKET` binding (or any account that selected no backend)
 *    reads `not_defined` too, not just stock Node.
 *  - `not_defined`    — the deployment CAN use it but the operator hasn't set it up (banner-worthy):
 *    no environment/runner-pool connection registered, or the account selected no content-storage
 *    backend (Node defaults to `off`).
 *  - `configured`     — a connection / backend is defined.
 *
 * IMPORTANT: this is an ADVISORY projection for a banner — it must never break the workspace
 * snapshot (the board load). Each area's read is fault-isolated: a read that throws (e.g. a
 * mothership persistence RPC that doesn't expose the connection repo, or a rotated encryption key
 * that fails a secret decrypt) OR hangs past {@link AREA_PROBE_TIMEOUT_MS} degrades that area to
 * `not_applicable` ("can't tell → don't nag") rather than 500-ing / stalling `GET /workspaces/:id`.
 * A swallowed error/timeout is logged (best-effort) so a persistent misconfig that reads as
 * `not_applicable` is still diagnosable instead of silently invisible.
 */

/** Structural best-effort logger (the facade's pino logger); a swallowed probe fault is logged here. */
export interface InfraSetupLogger {
  warn(obj: Record<string, unknown>, msg?: string): void
}

/** Cap on a single area probe so a slow/stuck backend read can't stall the whole board snapshot. */
export const AREA_PROBE_TIMEOUT_MS = 2000

export async function areaStatus(
  wired: boolean,
  read: () => Promise<unknown>,
  opts: { area?: string; logger?: InfraSetupLogger; timeoutMs?: number } = {},
): Promise<'not_applicable' | 'not_defined' | 'configured'> {
  if (!wired) return 'not_applicable'
  const timeoutMs = opts.timeoutMs ?? AREA_PROBE_TIMEOUT_MS
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const result = await Promise.race([
      read(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`infra-setup probe timed out after ${timeoutMs}ms`)),
          timeoutMs,
        )
      }),
    ])
    return result ? 'configured' : 'not_defined'
  } catch (err) {
    opts.logger?.warn(
      { area: opts.area, err: err instanceof Error ? err.message : String(err) },
      'infra-setup probe failed; degrading area to not_applicable',
    )
    return 'not_applicable'
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * The subset of the request container `snapshotInfraSetup` reads. Named (rather than inlined)
 * so the presence-probe method shapes are explicit and a signature change is caught here.
 *
 * The env/runner probes use `hasConnection` — a yes/no that does NOT decrypt the secret bundle.
 * `resolveBinaryArtifactStore` is the store's single source of truth (an account can select a
 * backend whose credentials don't yet resolve, which a presence-only check couldn't tell from a
 * live one); it reads through the AccountSettingsService's short-TTL cache, so the underlying
 * secret decrypt is amortized across board loads rather than paid on each.
 */
export interface InfraSetupSources {
  environments?: { connectionService: { hasConnection(ws: string): Promise<boolean> } }
  runners?: { connectionService: { hasConnection(ws: string): Promise<boolean> } }
  /**
   * True ONLY when a self-hosted runner pool is the sole execution backend for container agents
   * (so an unregistered pool means NO agent can run) — i.e. this facade has no built-in per-run
   * container runtime. Only remote/stock Node sets it: Cloudflare has built-in per-run containers
   * and local mode runs agents in per-run HOST containers, so on both the pool is an OPTIONAL
   * alternate target, not the executor of record. Without this gate the mere presence of the
   * (always-wired-on-Node, opt-in-on-Cloudflare) runner surface would falsely nag "no agent can
   * run" on local mode and on a Cloudflare deployment that set `RUNNERS_ENABLED`.
   */
  agentExecutorRequiresRunnerPool?: boolean
  resolveBinaryArtifactStore?: (ws: string) => Promise<unknown>
}

export async function snapshotInfraSetup(
  container: InfraSetupSources,
  workspaceId: string,
  logger: InfraSetupLogger = sharedLogger,
): Promise<InfraSetup> {
  const [ephemeralEnvironments, agentExecutor, binaryStorage] = await Promise.all([
    areaStatus(
      !!container.environments,
      () => container.environments!.connectionService.hasConnection(workspaceId),
      { area: 'ephemeralEnvironments', logger },
    ),
    areaStatus(
      !!container.runners && !!container.agentExecutorRequiresRunnerPool,
      () => container.runners!.connectionService.hasConnection(workspaceId),
      { area: 'agentExecutor', logger },
    ),
    areaStatus(
      !!container.resolveBinaryArtifactStore,
      () => container.resolveBinaryArtifactStore!(workspaceId),
      { area: 'binaryStorage', logger },
    ),
  ])
  return { ephemeralEnvironments, agentExecutor, binaryStorage }
}

function deploymentModelDefaults(routing: AgentRouting) {
  const ref = (r: ModelRef) => `${r.provider}:${r.model}`
  return {
    default: ref(routing.default.ref),
    byKind: Object.fromEntries(
      Object.entries(routing.byKind)
        .filter((entry): entry is [string, NonNullable<(typeof entry)[1]>] => entry[1] != null)
        .map(([kind, cfg]) => [kind, ref(cfg.ref)]),
    ),
  }
}
import type { Context } from 'hono'
import type { AppEnv } from '../../http/env.js'
import { param } from '../../http/params.js'
import { redactBoard, resolveDeniedFrameIds } from './redactFrames.js'

/** The signed-in user, narrowed to what the tenancy layer needs. */
function accountUser<E extends AppEnv>(c: Context<E>) {
  const user = c.get('user')
  return user ? { id: user.id, login: user.login, name: user.name } : null
}

/** Board (workspace) lifecycle and full-snapshot retrieval. */
export function workspaceController(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  // Boards visible to the signed-in user: those in any account they belong to,
  // plus any legacy board they personally own. When auth is disabled (`user`
  // unset) the scope is null → no scoping (every board, dev behaviour).
  buildHonoRoute(app, listWorkspacesContract, async (c) => {
    const container = c.get('container')
    const user = accountUser(c)
    if (!user) return c.json(await container.workspaceService.list(null), 200)
    await container.accountService.ensurePersonalAccount(user)
    const accountIds = await container.accountService.accessibleAccountIds(user.id)
    return c.json(await container.workspaceService.list({ accountIds, ownerUserId: user.id }), 200)
  })

  buildHonoRoute(app, createWorkspaceContract, async (c) => {
    const container = c.get('container')
    const user = accountUser(c)
    const body = c.req.valid('json')

    // Resolve the owning account: an explicit one the caller belongs to, else the
    // caller's personal account; unscoped when there's no signed-in user (dev).
    let accountId: string | null = null
    if (user) {
      if (body.accountId) {
        // Membership is required — a non-member is told the account doesn't exist.
        await container.accountService.requireMember(body.accountId, user.id)
        accountId = body.accountId
      } else {
        accountId = (await container.accountService.ensurePersonalAccount(user)).id
      }
    } else if (body.accountId) {
      accountId = body.accountId
    }

    const snapshot = await container.workspaceService.create(body, user?.id ?? null, accountId)
    // Carry the SAME tiered-budget fields the GET snapshot attaches (budgetCaps + the
    // account/user tier status + editable settings), because the SPA hydrates its stores
    // directly from this create response — omitting them would leave a freshly-created
    // workspace with no operator caps / tier meters until a separate snapshot refresh.
    const [spend, infraSetup, budgetTiers] = await Promise.all([
      container.spendService.status(snapshot.workspace.id),
      snapshotInfraSetup(container, snapshot.workspace.id),
      assembleBudgetTiers(container, { accountId, viewerUserId: user?.id }),
    ])
    const customAgentKinds = snapshotCustomAgentKinds(container.agentKindRegistry)
    // The registered initiative presets (built-in generic + any a deployment mixed in). Static
    // process-global registry, so identical for every workspace and both facades — attached here
    // in the shared controller (like `customAgentKinds`) rather than per-facade.
    const initiativePresets = initiativePresetDescriptors()
    return c.json(
      {
        ...snapshot,
        spend,
        ...budgetTiers,
        agentConfigCatalog: snapshotAgentConfigCatalog(snapshot, container.agentKindRegistry),
        deploymentModelDefaults: deploymentModelDefaults(container.config.agents.routing),
        ...(customAgentKinds ? { customAgentKinds } : {}),
        ...(initiativePresets.length ? { initiativePresets } : {}),
        ...snapshotBackendKinds(container),
        infraSetup,
      },
      201,
    )
  })

  buildHonoRoute(app, getWorkspaceContract, async (c) => {
    const container = c.get('container')
    const workspaceId = param(c, 'workspaceId')
    // The workspace's owning account, resolved ONCE and reused for both the shared-service
    // catalog (below) and the account-tier budget widget (a single lookup, not two).
    const budgetAccountId = await container.workspaceService.accountOf(workspaceId)
    // Every ingredient below is an independent read keyed by the workspace id (only the
    // service catalog chains on the owning account), so they run concurrently: the
    // board-load latency is the slowest read, not the sum of ~15 sequential round-trips.
    const [
      snapshot,
      spend,
      // Bootstrap runs, so the board renders a bootstrap's live progress / failure +
      // retry the moment it loads (no separate, independently failing fetch). undefined
      // when the bootstrap module isn't configured.
      bootstrapJobs,
      // Env-config-repair runs (the durable agent fallback for provider config), so the
      // infrastructure-providers window renders a repair's live progress / outcome on load.
      envConfigRepairJobs,
      // Open notifications + merge-preset library, so the board renders the inbox,
      // per-block badges and the task preset picker on load.
      notifications,
      mergePresets,
      // The workspace's shared stacks (long-lived compose infra a consumer environment
      // attaches to), so the Infrastructure window renders the library + each stack's
      // live status on load.
      sharedStacks,
      // The workspace's model presets (the model→agent mapping library a task picks
      // from), so the board renders the Model Configuration settings + the per-task
      // preset picker on load. `list` seeds the built-in presets (Kimi K2.7 default +
      // GLM-5.2) on first read.
      modelPresets,
      // The workspace's default service-fragment selection, for the defaults settings.
      serviceFragmentDefaults,
      // The workspace's recurring pipelines + issue-tracker selection, so the board
      // renders the recurring-task badges and the tracker config on load. Run history
      // is fetched lazily, not here.
      recurringPipelines,
      trackerSettings,
      // The workspace's initiatives (long-running multi-task work containers), so the
      // board renders initiative cards + trackers on load.
      initiatives,
      // The workspace's runtime settings (human-wait escalation threshold + per-service
      // task limit), so the board renders the settings panel on load.
      settings,
      // In-org shared services: the workspace's mounts + the org catalog it can mount
      // from (each catalog service annotated with its mount count for the "Shared" badge).
      mounts,
      serviceCatalog,
      infraSetup,
      // The workspace's projected repos (with each repo's `linkedVia`), so the per-viewer
      // redaction can tell an App-reachable frame from a personal-PAT one. Only when GitHub is
      // wired; absent ⇒ no personal repos, so nothing to redact.
      repoProjections,
    ] = await Promise.all([
      container.workspaceService.snapshot(workspaceId),
      container.spendService.status(workspaceId),
      container.bootstrap?.service.listJobs(workspaceId),
      container.envConfigRepair?.service.listJobs(workspaceId),
      container.notifications?.service.listOpen(workspaceId),
      container.mergePresets?.service.list(workspaceId),
      container.sharedStacks?.service.list(workspaceId),
      container.modelPresets?.service.list(workspaceId),
      container.serviceFragmentDefaults?.service.get(workspaceId),
      container.recurring?.service.list(workspaceId),
      container.tracker?.service.get(workspaceId),
      container.initiatives?.service.list(workspaceId),
      container.settings?.service.get(workspaceId),
      container.services?.service.listMounts(workspaceId),
      container.services && budgetAccountId !== undefined
        ? container.services.service.listForAccount(budgetAccountId)
        : undefined,
      snapshotInfraSetup(container, workspaceId),
      container.github ? container.github.service.listRepos(workspaceId) : undefined,
    ])
    const customAgentKinds = snapshotCustomAgentKinds(container.agentKindRegistry)
    // The registered initiative presets (built-in generic + any a deployment mixed in). Static
    // process-global registry, so identical for every workspace and both facades — attached here
    // in the shared controller (like `customAgentKinds`) rather than per-facade.
    const initiativePresets = initiativePresetDescriptors()

    // Redact service frames backed by a repo linked via ANOTHER member's personal PAT that this
    // viewer can't reach (fail closed): scrub the frame to a locked stub + drop its subtree, so
    // the SPA shows "Permission denied" instead of the service's contents. A no-op when no repo
    // is personal or GitHub isn't wired.
    const deniedFrameIds = await resolveDeniedFrameIds({
      viewerUserId: c.get('user')?.id,
      services: serviceCatalog ?? [],
      repos: repoProjections ?? [],
      userRepoAccess: container.userRepoAccess,
    })
    const redacted = redactBoard(
      {
        blocks: snapshot.blocks,
        executions: snapshot.executions,
        services: serviceCatalog,
        bootstrapJobs,
        notifications,
      },
      deniedFrameIds,
    )

    // Tiered budgets: the account-tier status (this workspace's owning account) and the
    // signed-in caller's user-tier status + editable settings, plus the operator hard caps.
    // Each tier's status is absent when that tier is inactive (no configured limit + no cap).
    const budgetTiers = await assembleBudgetTiers(container, {
      accountId: budgetAccountId,
      viewerUserId: c.get('user')?.id,
    })

    return c.json(
      {
        ...snapshot,
        blocks: redacted.blocks,
        executions: redacted.executions,
        spend,
        ...budgetTiers,
        ...(redacted.bootstrapJobs ? { bootstrapJobs: redacted.bootstrapJobs } : {}),
        ...(envConfigRepairJobs ? { envConfigRepairJobs } : {}),
        ...(redacted.notifications ? { notifications: redacted.notifications } : {}),
        ...(mergePresets ? { mergePresets } : {}),
        ...(sharedStacks ? { sharedStacks } : {}),
        ...(modelPresets ? { modelPresets } : {}),
        ...(serviceFragmentDefaults ? { serviceFragmentDefaults } : {}),
        ...(recurringPipelines ? { recurringPipelines } : {}),
        ...(trackerSettings ? { trackerSettings } : {}),
        ...(initiatives ? { initiatives } : {}),
        ...(settings ? { settings } : {}),
        ...(mounts ? { mounts } : {}),
        ...(redacted.services ? { serviceCatalog: redacted.services } : {}),
        agentConfigCatalog: snapshotAgentConfigCatalog(snapshot, container.agentKindRegistry),
        deploymentModelDefaults: deploymentModelDefaults(container.config.agents.routing),
        ...(customAgentKinds ? { customAgentKinds } : {}),
        ...(initiativePresets.length ? { initiativePresets } : {}),
        ...snapshotBackendKinds(container),
        infraSetup,
      },
      200,
    )
  })

  buildHonoRoute(app, updateWorkspaceContract, async (c) => {
    const body = c.req.valid('json')
    const workspace = await c.get('container').workspaceService.update(param(c, 'workspaceId'), {
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...('description' in body ? { description: body.description } : {}),
    })
    return c.json(workspace, 200)
  })

  buildHonoRoute(app, deleteWorkspaceContract, async (c) => {
    await c.get('container').workspaceService.delete(param(c, 'workspaceId'))
    return c.body(null, 204)
  })

  return app
}
