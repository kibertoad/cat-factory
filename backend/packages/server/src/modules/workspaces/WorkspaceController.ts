import {
  createWorkspaceContract,
  deleteWorkspaceContract,
  getWorkspaceContract,
  listWorkspacesContract,
  updateWorkspaceContract,
} from '@cat-factory/contracts'
import { BINARY_OUTPUT_TRAIT, configContributionCatalog, hasTrait } from '@cat-factory/agents'
import { buildHonoRoute } from '@toad-contracts/hono'
import { Hono } from 'hono'
import { logger as sharedLogger } from '../../observability/logger.js'
// The per-area infra-setup projection, extracted so the reachability watcher shares its
// applicability rule (`infraSetupAreaApplies`) rather than re-deriving a looser one.
import { snapshotInfraSetup } from './infraSetup.js'
import type { EnvironmentBackendRegistry, RunnerBackendRegistry } from '@cat-factory/integrations'
import type {
  BackendKindOption,
  BudgetCaps,
  AgentKindVariant,
  CustomAgentKind,
  CustomTaskType,
  GateConfigForm,
  InitiativePresetDescriptor,
  RegisteredBinaryGenerator,
  SkillSummary,
  SpendStatus,
  TutorialProgress,
  UserSettings,
  WorkspaceSnapshot,
} from '@cat-factory/contracts'
import type { AgentKindRegistry, AgentRouting } from '@cat-factory/agents'
import {
  applyInfraReachability,
  recordedUnreachableAreas,
  resolveWorkspaceAccess,
  runBestEffort,
} from '@cat-factory/kernel'
import { suppressedTaskTypeIds } from '@cat-factory/orchestration'
import type { AccountRole, ModelRef, TaskTypeRegistry, WorkspaceRole } from '@cat-factory/kernel'
import type { Workspace } from '@cat-factory/contracts'
import type { ServerContainer } from '../../http/env.js'

/**
 * The signed-in caller's in-app tutorial progress for a snapshot, or undefined.
 *
 * Best-effort, exactly like the budget tiers beside it and for the same reason: on a
 * mothership-mode node this read crosses the machine API, and a walkthrough-history list must
 * never be able to 500 a board load. A failure degrades to absent, which the SPA reads as "no
 * server copy" and answers from its own browser-persisted store — the behaviour before this
 * existed. Unlike the budget reads it routes through `runBestEffort`, so the swallow is reported
 * rather than silent.
 */
async function snapshotTutorialProgress(
  container: ServerContainer,
  viewerUserId: string | undefined,
): Promise<TutorialProgress | undefined> {
  const progress = container.tutorialProgress
  if (!viewerUserId || !progress) return undefined
  return await runBestEffort(container.logger, 'snapshot tutorial progress', () =>
    progress.service.get(viewerUserId),
  )
}

/**
 * Every snapshot slice resolved for the SIGNED-IN VIEWER rather than for the board: the tiered
 * budget widgets and their editable settings, plus the viewer's tutorial progress.
 *
 * One collaborator so the two response paths (the GET snapshot and the POST-create response, which
 * the SPA hydrates from directly) cannot drift on which viewer-scoped fields they carry — the same
 * reason `assembleBudgetTiers` exists one level down. Resolved in ONE wave: on a mothership-mode
 * node each of these crosses the machine API, so awaiting them in sequence would add a round trip
 * to every board load for nothing.
 */
async function assembleViewerSlices(
  container: ServerContainer,
  opts: { accountId: string | null | undefined; viewerUserId: string | undefined },
) {
  const [budgetTiers, tutorialProgress] = await Promise.all([
    assembleBudgetTiers(container, opts),
    snapshotTutorialProgress(container, opts.viewerUserId),
  ])
  return { ...budgetTiers, ...(tutorialProgress ? { tutorialProgress } : {}) }
}

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
function snapshotCustomAgentKinds(
  registry: AgentKindRegistry,
  container: ServerContainer,
): CustomAgentKind[] | undefined {
  const kinds = registry
    .all()
    .filter((def) => def.presentation)
    .map((def) => ({
      kind: def.kind,
      presentation: def.presentation!,
      container: registry.requiresContainer(def.kind),
      // Asked of the REGISTRY, not read off `def.traits`: a trait also reaches a kind through
      // `assignTraits`, and a projection that read the declaration alone would tell the builder
      // a kind needs no storage selection right up until its run is refused at admission.
      ...(hasTrait(def.kind, BINARY_OUTPUT_TRAIT, registry) ? { binaryOutput: true } : {}),
      // Asked of the REGISTRY for the same reason the trait is: a companion PAIRING is
      // registered separately from the kind (`registerCompanion`), so reading the kind's own
      // definition would miss every one of them. Absent for a kind that reviews nothing, which
      // is what tells the builder to render it as an ordinary palette block.
      ...(registry.isCompanionKind(def.kind)
        ? { companionTargets: registry.companionTargets(def.kind) }
        : {}),
    }))
  // Registered JUDGES (the fourth step-taxonomy bucket) reach the palette through the SAME
  // projection: a judge is a step kind the SPA must be able to place and open a result window
  // for, and it is never a container kind (its assessment is an inline LLM call). They ride the
  // agent-kind list rather than a parallel snapshot field so the SPA's existing palette merge +
  // result-view dispatch pick them up with no frontend branching.
  const judges = container.executionService.registeredJudges().flatMap((judge) =>
    judge.presentation
      ? [
          {
            kind: judge.kind,
            presentation: { resultView: 'judge' as const, ...judge.presentation },
            container: false,
          },
        ]
      : [],
  )
  const all = [...kinds, ...judges]
  return all.length > 0 ? all : undefined
}

/**
 * The registered agent-kind VARIANTS — a deployment's alternate prompts for EXISTING kinds —
 * mapped to the wire shape the pipeline builder offers on a step of the matching kind and the
 * run views name a varied step with. A variant with no `presentation` falls back to its id: it is
 * still selectable, so hiding it would leave a configured pipeline showing a step option the SPA
 * cannot name. Static (process-global registry), so identical for every workspace and every
 * facade; undefined when none are registered, so the field is absent on the stock product.
 */
function snapshotAgentKindVariants(registry: AgentKindRegistry): AgentKindVariant[] | undefined {
  const variants = registry.variants().map((variant) => ({
    id: variant.id,
    baseKind: variant.baseKind,
    label: variant.presentation?.label ?? variant.id,
    ...(variant.presentation?.description ? { description: variant.presentation.description } : {}),
  }))
  return variants.length > 0 ? variants : undefined
}

/**
 * The registered CUSTOM task types, mapped to the wire shape the SPA merges into its
 * task-type catalog (create-task choice + card badge). The registry already stores the
 * wire projection, so this is a straight `all()` minus what this board SUPPRESSES.
 *
 * The one member of this bag that is NOT workspace-independent, and the reason the projections
 * take a workspace at all: an org registers its reusable operations process-wide, so a workspace
 * admin can hide the ones that board does not run
 * (`backend/docs/reusable-operations.md`). Filtering HERE rather than in the SPA is what makes the
 * suppression real: the picker, the card badges and the create-form all read this one list, and
 * `BoardService` refuses a suppressed type independently so no other door bypasses it.
 *
 * Returns undefined when nothing survives, so the field is simply absent on the stock product,
 * symmetric with {@link snapshotCustomAgentKinds}.
 */
function snapshotCustomTaskTypes(
  registry: TaskTypeRegistry,
  suppressed: ReadonlySet<string>,
): CustomTaskType[] | undefined {
  const types = registry.all().filter((type) => !suppressed.has(type.taskType))
  return types.length > 0 ? types : undefined
}

/**
 * The complement of {@link snapshotCustomTaskTypes}: the registered ids this board HIDES.
 *
 * Narrowed to ids the registry still knows, so a tombstone left by a WITHDRAWN registration is
 * absent here exactly as it is absent from the settings screen: it names an operation with no
 * label, no description and no fields, and reporting it would have the SPA count a row it can
 * neither render nor act on.
 *
 * Without this the offered catalog is ambiguous in the one direction that traps a user. An admin
 * hiding the last operation empties `customTaskTypes`, which reads identically to a stock
 * deployment that registers none, so the SPA drops the settings tab that is the ONLY way to
 * un-hide one. Absent and empty are different facts here, and this is the field that states which.
 */
function snapshotSuppressedTaskTypes(
  registry: TaskTypeRegistry,
  suppressed: ReadonlySet<string>,
): string[] | undefined {
  const ids = registry
    .all()
    .map((type) => type.taskType)
    .filter((taskType) => suppressed.has(taskType))
  return ids.length > 0 ? ids : undefined
}

/**
 * The deployment's GENERATIVE BINARY INTEGRATIONS as the snapshot carries them, for the pipeline
 * builder's binary-output step picker. Static, identical for every workspace and both facades,
 * exactly like {@link snapshotCustomTaskTypes}.
 *
 * Read through the resolved SOURCE, not the container's own registry, and that is the whole point
 * of the read being here rather than inline: the picker is what SELECTS a `generatorIds` entry and
 * run admission is what resolves it, so the two must be looking at one set. On a mothership-mode
 * node the set is the mothership's, and a picker fed from this node's registry would offer ids
 * admission rejects (or, once a deployment stops double-registering, offer nothing at all while
 * runs resolve fine) — the same drift the source exists to remove, just moved one surface along.
 *
 * Projects IDENTITY ONLY. The view also holds each integration's credential declaration, endpoint
 * and contract summaries, and none of them may cross to a workspace VIEWER: the credential's key
 * name discloses the deployment's environment for no benefit (the picker never uses it), and the
 * endpoint and contracts are the AGENT's interface, delivered as injected context at dispatch.
 *
 * Three outcomes, and the third is why this returns a pair rather than a list. `undefined` means
 * the deployment registers none — the default, since the platform ships no integrations — so the
 * field is simply absent on the stock product. A list means these are the registered ones. And
 * `unavailable` means the set could not be READ: it must not render as the first, because a picker
 * silently offering nothing invites someone to conclude the deployment has no integrations and go
 * looking in the wrong build. It never throws — an unreachable mothership must not take the whole
 * board load down over a picker on one step type.
 */
async function snapshotBinaryGenerators(
  container: ServerContainer,
): Promise<{ generators?: RegisteredBinaryGenerator[]; unavailable?: true }> {
  const views = await runBestEffort(
    container.logger,
    'snapshot.binaryGenerators',
    () => container.binaryGenerators.views(),
    {},
  )
  if (!views) return { unavailable: true }
  const generators = views.map((view) => ({
    id: view.id,
    name: view.name,
    summary: view.summary,
    modalities: view.modalities,
    ...(view.mediaTypes.length > 0 ? { mediaTypes: view.mediaTypes } : {}),
    // Projected only when the definition DECLARED some. An empty array and an absent field are
    // one state in the coverage rule ("only the coarse facts are known"), and carrying the empty
    // array would make every builder render "supports nothing" for a definition that said
    // nothing: the same absent-reads-as-zero mistake the rest of this surface avoids.
    ...(view.capabilities.length > 0 ? { capabilities: view.capabilities } : {}),
    // Carried for the same reason, and already absent-or-declared on the view: the builder judges
    // a step's aspect ratio and output size against it, so omitting it would leave the picker
    // silent about a value the only selected endpoint refuses.
    ...(view.accepts ? { accepts: view.accepts } : {}),
  }))
  return generators.length > 0 ? { generators } : {}
}

/**
 * Every snapshot field projected from an APP-OWNED REGISTRY, in one read.
 *
 * The five have identical provenance and identical lifetime — deployment-registered composition
 * data on the request container, workspace-independent, the same for both facades — and both
 * snapshot routes need the whole set. Computing them one const at a time duplicated the block
 * across the two handlers and put every future registry's line into `workspaceController` twice,
 * which is what pushed that function over its budget when the generative-integration projection
 * arrived. Adding the next one is now a line HERE and nothing in the handlers.
 *
 * Each member is `undefined` rather than empty when its registry holds nothing, so the field is
 * absent on the wire for the stock product and the SPA's `?? []` fallbacks are what answer.
 *
 * ASYNC because one of the five is no longer necessarily in-process: the generative integrations
 * are read through a source a mothership-mode node points at the mothership. The other four stay
 * synchronous reads inside it — an agent kind carries FUNCTIONS, so it could not cross a wire even
 * if we wanted it to, and nothing has asked the rest to.
 */
async function snapshotRegistryProjections(
  container: ServerContainer,
  /**
   * The board whose suppressions apply, or undefined at CREATE time: a workspace that does not
   * exist yet cannot have hidden anything, so reading for it would be a round trip whose only
   * possible answer is the empty set.
   */
  workspaceId?: string,
): Promise<{
  customAgentKinds: CustomAgentKind[] | undefined
  agentKindVariants: AgentKindVariant[] | undefined
  customTaskTypes: CustomTaskType[] | undefined
  suppressedTaskTypes: string[] | undefined
  gateConfigForms: GateConfigForm[] | undefined
  binaryGenerators: RegisteredBinaryGenerator[] | undefined
  /** Set only when the set could not be READ — never alongside `binaryGenerators`. */
  binaryGeneratorsUnavailable: true | undefined
  initiativePresets: InitiativePresetDescriptor[] | undefined
}> {
  const [binaryGenerators, suppressedTaskTypes] = await Promise.all([
    snapshotBinaryGenerators(container),
    workspaceId
      ? suppressedTaskTypeIds(
          container.taskTypeSuppressions?.service,
          workspaceId,
          container.logger,
        )
      : Promise.resolve(new Set<string>()),
  ])
  return {
    customAgentKinds: snapshotCustomAgentKinds(container.agentKindRegistry, container),
    agentKindVariants: snapshotAgentKindVariants(container.agentKindRegistry),
    customTaskTypes: snapshotCustomTaskTypes(container.taskTypeRegistry, suppressedTaskTypes),
    suppressedTaskTypes: snapshotSuppressedTaskTypes(
      container.taskTypeRegistry,
      suppressedTaskTypes,
    ),
    // The per-step parameters each registered gate declares, so the pipeline builder can render a
    // gate's own config form. Read off the SAME registry instance run admission validates against,
    // so what the builder offers is exactly what a run will accept.
    gateConfigForms: definedIfPresent(
      container.gateRegistry.configForms().map(({ kind, fields }) => ({
        kind,
        fields: [...fields],
      })),
    ),
    binaryGenerators: binaryGenerators.generators,
    binaryGeneratorsUnavailable: binaryGenerators.unavailable,
    // The registered initiative presets (built-in generic + any a deployment mixed in), driving
    // the initiative create picker and which planning pipeline "Run planning" starts. Emptiness
    // is folded to `undefined` HERE rather than at each handler, so every member of this bag
    // obeys one rule and a handler can spread the whole thing through `definedFields`.
    initiativePresets: definedIfPresent(container.initiativePresetRegistry.descriptors()),
  }
}

/** A list, or undefined when it is empty — the absent-on-the-wire convention, applied once. */
function definedIfPresent<T>(list: T[]): T[] | undefined {
  return list.length > 0 ? list : undefined
}

/**
 * The account's repo-sourced Claude Skills as lightweight snapshot summaries (`{ id, name,
 * description }`) for the pipeline builder's per-step skill picker (ADR 0024
 * slice 3). Read through the account skill-catalog cache — one read for the whole account, shared
 * across its workspaces (see "No N+1"). Best-effort: the skill library is optional and must NEVER
 * break the board load, so an unwired library, an unresolved account, or a read failure degrades
 * to `undefined` (the picker simply has no options) rather than 500-ing the snapshot. Returns
 * undefined when there is nothing to attach, so the field is absent on the stock/empty product.
 */
async function snapshotSkills(
  container: ServerContainer,
  accountId: string | null | undefined,
): Promise<SkillSummary[] | undefined> {
  if (!container.skillLibrary || accountId == null) return undefined
  try {
    const skills = await container.skillLibrary.catalogService.list(accountId)
    return skills.length
      ? skills.map((s) => ({ id: s.id, name: s.name, description: s.description }))
      : undefined
  } catch (err) {
    // Best-effort: log the swallowed fault (like the infra-setup probe above) so a misconfigured
    // library is visible in the operator log, but never let it 500 the board snapshot.
    sharedLogger.warn('skill catalog read failed; degrading snapshot skills to none', {
      accountId,
      err: err instanceof Error ? err.message : String(err),
    })
    return undefined
  }
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
import { loadWorkspaceAccess, requirePermission } from '../../http/workspaceAccess.js'
import { redactBoard, resolveDeniedFrameIds } from './redactFrames.js'

/**
 * The signed-in user, narrowed to what the tenancy layer needs, or `null` when there is none.
 * Deliberately NOT the `requireAccountUser` of the account-scoped controllers: both routes here
 * answer for an anonymous caller (dev-open runs with auth disabled — board listing falls back to
 * the unscoped list, board creation to an unscoped board), so a 401 would break that mode.
 */
function optionalAccountUser<E extends AppEnv>(c: Context<E>) {
  const user = c.get('user')
  return user ? { id: user.id, login: user.login, name: user.name } : null
}

/**
 * The caller's EFFECTIVE workspace role for a board in `GET /workspaces`, computed in-memory
 * from the visibility scopes + one batched member-row read (no per-board round-trip). Reuses
 * the SAME `resolveWorkspaceAccess` decision the gate runs, so the badge can't drift from
 * enforcement. Only `admin`-ness and membership of an account matter to resolution, so the
 * synthetic account-role stand-in (`['admin']` / `['developer']` / `[]`) is faithful. A legacy
 * board only appears in the list when the caller owns it, so it resolves to `admin` directly.
 * `undefined` ⇒ no role to badge (a board reachable purely via account membership in account
 * mode still resolves to `member`, so `undefined` is effectively unreachable for a listed board
 * — kept for a denied edge that never surfaces).
 */
function effectiveWorkspaceRole(
  userId: string,
  workspace: Workspace,
  ctx: { accountSet: Set<string>; adminSet: Set<string>; memberRole: WorkspaceRole | null },
): WorkspaceRole | undefined {
  if (workspace.accountId === null) return 'admin'
  const accountRoles: AccountRole[] = ctx.adminSet.has(workspace.accountId)
    ? ['admin']
    : ctx.accountSet.has(workspace.accountId)
      ? ['developer']
      : []
  const access = resolveWorkspaceAccess({
    userId,
    workspace: {
      accountId: workspace.accountId,
      ownerUserId: null,
      accessMode: workspace.accessMode ?? 'account',
    },
    accountRoles,
    memberRole: ctx.memberRole,
  })
  return access.allowed ? access.role : undefined
}

/**
 * Spread-ready projection of the OPTIONAL board-snapshot slices: keeps only the entries whose
 * value is present (truthy), exactly as the former ladder of `...(x ? { x } : {})` spreads did —
 * a wired module returns its slice, an unwired one returns undefined (dropped). Folding the ~18
 * conditional spreads into one call keeps the snapshot handler within the complexity budget.
 */
function definedFields<T extends Record<string, unknown>>(fields: T): Partial<T> {
  const out: Partial<T> = {}
  for (const key of Object.keys(fields) as (keyof T)[]) {
    if (fields[key]) out[key] = fields[key]
  }
  return out
}

/**
 * The board-load READ WAVE: every slice `GET /workspaces/:id` composes its snapshot from.
 *
 * Extracted from the handler as ONE cohesive collaborator rather than a set of per-slice
 * helpers, because its defining property is that the reads are CONCURRENT — each is an
 * independent read keyed by the workspace id (only the service catalog chains on the owning
 * account), so the board-load latency is the slowest read, not the sum of ~20 sequential
 * round-trips. Splitting it per slice would be the one refactor that could silently
 * re-sequence them. Every optional module's slice is `undefined` when that module isn't
 * wired; the handler gates on that with `definedFields`.
 */
async function loadSnapshotSlices(
  container: ServerContainer,
  workspaceId: string,
  budgetAccountId: string | null | undefined,
) {
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
    // In-flight ephemeral-environment self-test runs, so the service inspector re-attaches
    // to a running test's live stage after a reconnect (see snapshot coherence note).
    environmentTestRuns,
    // Open notifications + merge-preset library, so the board renders the inbox,
    // per-block badges and the task preset picker on load.
    notifications,
    riskPolicies,
    // The workspace's shared stacks (long-lived compose infra a consumer environment
    // attaches to), so the Infrastructure window renders the library + each stack's
    // live status on load.
    sharedStacks,
    // The workspace's model presets (the model→agent mapping library a task picks
    // from), so the board renders the Model Configuration settings + the per-task
    // preset picker on load. `list` seeds the built-in presets (Kimi K2.7 default +
    // GLM-5.2) on first read.
    modelPresets,
    // The workspace's consensus-group library (the estimate-gated panels a pipeline step
    // escalates to), so the builder's per-step tier picker and the settings editor render
    // on load.
    consensusGroups,
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
    // The per-area SETUP states. `unreachable` is folded on below, off the notifications read that
    // is already in flight here, rather than probed on this hot path.
    infraSetup,
    // The workspace's projected repos (with each repo's `linkedVia`), so the per-viewer
    // redaction can tell an App-reachable frame from a personal-PAT one. Only when GitHub is
    // wired; absent ⇒ no personal repos, so nothing to redact.
    repoProjections,
    // The account's repo-sourced Claude Skills catalog (lightweight summaries), so the pipeline
    // builder's per-step skill picker has its options on load. One cached account read.
    skills,
  ] = await Promise.all([
    container.workspaceService.snapshot(workspaceId),
    container.spendService.status(workspaceId),
    container.bootstrap?.service.listJobs(workspaceId),
    container.envConfigRepair?.service.listJobs(workspaceId),
    container.environments?.environmentTest?.listRunning(workspaceId),
    container.notifications?.service.listOpen(workspaceId),
    container.riskPolicies?.service.list(workspaceId),
    container.sharedStacks?.service.list(workspaceId),
    container.modelPresets?.service.list(workspaceId),
    container.consensusGroups?.service.list(workspaceId),
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
    snapshotSkills(container, budgetAccountId),
  ])
  return {
    snapshot,
    spend,
    bootstrapJobs,
    envConfigRepairJobs,
    environmentTestRuns,
    notifications,
    riskPolicies,
    sharedStacks,
    modelPresets,
    consensusGroups,
    serviceFragmentDefaults,
    recurringPipelines,
    trackerSettings,
    initiatives,
    settings,
    mounts,
    serviceCatalog,
    // Fold the reachability watcher's recorded outage into the setup projection, so a reload
    // mid-outage still renders the banner. The record lives on the workspace's open
    // `infra_unreachable` card, which the `notifications` read above already fetched — so this
    // costs no extra query and, crucially, no probe on the board-load path.
    infraSetup: applyInfraReachability(
      infraSetup,
      recordedUnreachableAreas(
        notifications?.find((n) => n.type === 'infra_unreachable' && n.status === 'open'),
      ),
    ),
    repoProjections,
    skills,
  }
}

/** Board (workspace) lifecycle and full-snapshot retrieval. */
export function workspaceController(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  // Boards visible to the signed-in user (see WorkspaceVisibility): unrestricted boards in
  // accounts they belong to, ANY board in accounts they admin (escape hatch), boards they
  // hold an explicit member row on, and legacy boards they personally own. When auth is
  // disabled (`user` unset) the scope is null → no scoping (every board, dev behaviour). Each
  // returned board is annotated with the caller's EFFECTIVE workspace role (`viewerRole`) via
  // one batched member-row read combined with the in-memory account-scope map.
  buildHonoRoute(app, listWorkspacesContract, async (c) => {
    const container = c.get('container')
    const user = optionalAccountUser(c)
    if (!user) return c.json(await container.workspaceService.list(null), 200)
    await container.accountService.ensurePersonalAccount(user)
    const { accountIds, adminAccountIds } = await container.accountService.accessibleAccountScopes(
      user.id,
    )
    const boards = await container.workspaceService.list({
      accountIds,
      adminAccountIds,
      ownerUserId: user.id,
      userId: user.id,
    })
    const memberRoles = await container.workspaceService.rolesForUserInWorkspaces(
      user.id,
      boards.map((w) => w.id),
    )
    const accountSet = new Set(accountIds)
    const adminSet = new Set(adminAccountIds)
    const annotated = boards.map((w) => {
      const role = effectiveWorkspaceRole(user.id, w, {
        accountSet,
        adminSet,
        memberRole: memberRoles.get(w.id) ?? null,
      })
      return role ? { ...w, viewerRole: role } : w
    })
    return c.json(annotated, 200)
  })

  buildHonoRoute(app, createWorkspaceContract, async (c) => {
    const container = c.get('container')
    const user = optionalAccountUser(c)
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
    // In the SAME wave as the rest, not awaited after it: on a mothership-mode node one of these
    // projections crosses the machine API, and serialising that round trip behind the batch adds
    // its latency to every workspace create for nothing.
    const [spend, infraSetup, viewerSlices, skills, registryProjections] = await Promise.all([
      container.spendService.status(snapshot.workspace.id),
      snapshotInfraSetup(container, snapshot.workspace.id),
      assembleViewerSlices(container, { accountId, viewerUserId: user?.id }),
      snapshotSkills(container, accountId),
      snapshotRegistryProjections(container),
    ])
    // The creator's resolved access. The gate doesn't run for the id-less create route, so resolve
    // it here (the creator is auto-enrolled admin, so this is always an admin grant when signed in).
    const resolved = user
      ? await loadWorkspaceAccess(container, snapshot.workspace.id, user.id)
      : null
    const access =
      resolved && resolved.allowed
        ? { role: resolved.role, permissions: [...resolved.permissions] }
        : undefined
    return c.json(
      {
        ...snapshot,
        spend,
        ...viewerSlices,
        ...(access ? { access } : {}),
        agentConfigCatalog: snapshotAgentConfigCatalog(snapshot, container.agentKindRegistry),
        deploymentModelDefaults: deploymentModelDefaults(container.config.agents.routing),
        // Every app-owned registry projection in one spread: each member is already `undefined`
        // when it has nothing to say, so adding the next registry is a line in the helper and
        // nothing here — which is what that helper promised and what the per-field ladder kept
        // taking back.
        ...definedFields({ ...registryProjections, skills }),
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
    //
    // The registry projections join that wave rather than following it. They are in-process on
    // every deployment but one — a mothership-mode node reads its generative integrations over
    // the machine API — and a board load is the hottest path this handler has, so awaiting them
    // afterwards put a whole round trip on the end of every refresh for nothing.
    const [slices, registryProjections] = await Promise.all([
      loadSnapshotSlices(container, workspaceId, budgetAccountId),
      snapshotRegistryProjections(container, workspaceId),
    ])
    const {
      snapshot,
      spend,
      bootstrapJobs,
      envConfigRepairJobs,
      environmentTestRuns,
      notifications,
      riskPolicies,
      sharedStacks,
      modelPresets,
      consensusGroups,
      serviceFragmentDefaults,
      recurringPipelines,
      trackerSettings,
      initiatives,
      settings,
      mounts,
      serviceCatalog,
      infraSetup,
      repoProjections,
      skills,
    } = slices

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
    const viewerSlices = await assembleViewerSlices(container, {
      accountId: budgetAccountId,
      viewerUserId: c.get('user')?.id,
    })

    // The caller's resolved workspace-RBAC access, published by the gate — zero extra reads.
    // Absent under dev-open (no signed-in user) ⇒ omitted ⇒ the SPA allows all (backend-parity).
    const resolvedAccess = c.get('workspaceAccess')
    const access =
      resolvedAccess && resolvedAccess.workspaceId === workspaceId
        ? { role: resolvedAccess.role, permissions: [...resolvedAccess.permissions] }
        : undefined

    return c.json(
      {
        ...snapshot,
        blocks: redacted.blocks,
        executions: redacted.executions,
        spend,
        ...viewerSlices,
        agentConfigCatalog: snapshotAgentConfigCatalog(snapshot, container.agentKindRegistry),
        deploymentModelDefaults: deploymentModelDefaults(container.config.agents.routing),
        ...snapshotBackendKinds(container),
        infraSetup,
        // The optional slices, present only when their module is wired / the value is non-empty.
        // Gathered through `definedFields` (truthy-gated — identical to the former
        // `...(x ? { x } : {})` ladder) so this handler stays within the complexity budget. None of
        // these keys collide with the unconditional fields above, so the single trailing spread is
        // order-equivalent to the original interleaved spreads.
        ...definedFields({
          access,
          bootstrapJobs: redacted.bootstrapJobs,
          envConfigRepairJobs,
          environmentTestRuns,
          notifications: redacted.notifications,
          riskPolicies,
          sharedStacks,
          modelPresets,
          consensusGroups,
          serviceFragmentDefaults,
          recurringPipelines,
          trackerSettings,
          initiatives,
          settings,
          mounts,
          serviceCatalog: redacted.services,
          ...registryProjections,
          skills,
        }),
      },
      200,
    )
  })

  buildHonoRoute(app, updateWorkspaceContract, async (c) => {
    // Board rename/description is workspace configuration (settings.manage), not a member write.
    // Per-handler (not a controller-level gate) because this controller also serves the ungated,
    // non-workspace-scoped `POST /workspaces` create + the `workspace.read` snapshot GET.
    requirePermission(c, 'settings.manage')
    const body = c.req.valid('json')
    const workspace = await c.get('container').workspaceService.update(param(c, 'workspaceId'), {
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...('description' in body ? { description: body.description } : {}),
    })
    return c.json(workspace, 200)
  })

  buildHonoRoute(app, deleteWorkspaceContract, async (c) => {
    requirePermission(c, 'settings.manage')
    await c.get('container').workspaceService.delete(param(c, 'workspaceId'))
    return c.body(null, 204)
  })

  return app
}
