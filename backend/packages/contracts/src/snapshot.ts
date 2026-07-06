import * as v from 'valibot'
import {
  blockSchema,
  budgetCapsSchema,
  executionInstanceSchema,
  pipelineSchema,
  spendStatusSchema,
  workspaceSchema,
} from './entities.js'
import { userSettingsSchema } from './user-settings.js'
import { bootstrapJobSchema } from './bootstrap.js'
import { envConfigRepairJobSchema } from './env-config-repair.js'
import { notificationSchema } from './notifications.js'
import { mergeThresholdPresetSchema } from './merge.js'
import { agentConfigCatalogSchema } from './agent-config.js'
import { modelPresetSchema } from './model-presets.js'
import { serviceFragmentDefaultsSchema } from './service-fragment-defaults.js'
import { pipelineScheduleSchema } from './recurring.js'
import { serviceSchema, workspaceMountSchema } from './services.js'
import { trackerSettingsSchema } from './tracker.js'
import { workspaceSettingsSchema } from './workspace-settings.js'
import { customAgentKindSchema } from './agent-presentation.js'
import { infraEngineSchema } from './environments.js'
import { infraSetupSchema } from './infra-setup.js'
import { initiativeSchema } from './initiative.js'
import { initiativePresetDescriptorSchema } from './initiative-preset.js'
import { sharedStackSchema } from './shared-stacks.js'

// The full board snapshot returned by GET /workspaces/:id (and POST /workspaces).
// It lives in its own module because it references both ./entities and
// ./bootstrap, and ./bootstrap imports from ./entities — defining it in either
// would be a circular import.

/** A selectable infra backend kind advertised to the SPA's connect form. */
export const backendKindOptionSchema = v.object({
  kind: v.string(),
  label: v.string(),
  /**
   * The per-type infra engines this backend implements (e.g. a `remote-custom` backend a
   * deployment registered). Lets the SPA offer the right backends per provision type — e.g.
   * the custom-handler form lists only backends that serve `remote-custom`. Populated for
   * environment backends; omitted for runner-pool backends (which have no engine axis).
   */
  engines: v.optional(v.array(infraEngineSchema)),
})
export type BackendKindOption = v.InferOutput<typeof backendKindOptionSchema>

export const workspaceSnapshotSchema = v.object({
  workspace: workspaceSchema,
  blocks: v.array(blockSchema),
  pipelines: v.array(pipelineSchema),
  executions: v.array(executionInstanceSchema),
  /**
   * Bootstrap runs for this workspace (the unified `agent_runs` table's bootstrap
   * rows). Carried in the snapshot so the board can render a bootstrap's live
   * progress / failure + retry the moment it loads, without a separate fetch that
   * could fail independently. Attached by the worker, so optional on the wire.
   */
  bootstrapJobs: v.optional(v.array(bootstrapJobSchema)),
  /**
   * Environment-provider config-repair runs for this workspace (the unified
   * `agent_runs` table's `env-config-repair` rows). Carried so the infrastructure
   * window can render a repair's live progress / outcome on load. Attached by the
   * facade, so optional on the wire.
   */
  envConfigRepairJobs: v.optional(v.array(envConfigRepairJobSchema)),
  /**
   * The current spend-safeguard status for the WORKSPACE tier. Attached by the
   * facade (it depends on deployment-wide pricing/budget config), so it is optional
   * on the wire.
   */
  spend: v.optional(spendStatusSchema),
  /**
   * The ACCOUNT-tier spend status (this period's spend across all the owning
   * account's workspaces vs the account budget). Attached only when the workspace
   * belongs to an account and the account tier is active (a limit or env cap is set).
   */
  accountSpend: v.optional(spendStatusSchema),
  /**
   * The USER-tier spend status for the signed-in caller (this period's spend across
   * every run they initiated vs their user budget). Attached only when the user tier
   * is active (a limit or env cap is set).
   */
  userSpend: v.optional(spendStatusSchema),
  /**
   * The signed-in caller's editable per-user settings (holds the user-tier budget),
   * so the budget screen can render the current value without a separate fetch.
   */
  userSettings: v.optional(userSettingsSchema),
  /**
   * Operator hard ceilings on the account/user budget tiers (from the deployment env
   * vars). Attached so the budget configuration screens can show the hard limit and
   * cap the input. Absent ⇒ this facade sets no ceilings.
   */
  budgetCaps: v.optional(budgetCapsSchema),
  /**
   * Open human-actionable notifications for this workspace (PRs awaiting a merge
   * decision, completed pipelines awaiting confirmation, CI that gave up). Carried
   * in the snapshot so the board renders the inbox + badges on load. Attached by
   * the worker, so optional on the wire.
   */
  notifications: v.optional(v.array(notificationSchema)),
  /**
   * The workspace's merge threshold presets (the library a task picks its
   * auto-merge policy from). Attached by the worker, so optional on the wire.
   */
  mergePresets: v.optional(v.array(mergeThresholdPresetSchema)),
  /**
   * The workspace's shared stacks (long-lived compose infra a consumer environment
   * attaches to over an external network — the acme-shared-services shape). Carried in
   * the snapshot so the Infrastructure window renders the library + each stack's live
   * status on load. Attached by the facade, so optional on the wire.
   */
  sharedStacks: v.optional(v.array(sharedStackSchema)),
  /**
   * The catalog of agent config-contribution descriptors (the task-level parameters
   * the registered agent kinds surface, e.g. the Tester's environment). The board
   * renders the subset whose owning kind appears in a task's selected pipeline.
   * Static metadata derived from the agent registry; attached by the facade, so
   * optional on the wire.
   */
  agentConfigCatalog: v.optional(agentConfigCatalogSchema),
  /**
   * The workspace's model presets — the library a task picks its model→agent
   * mapping from (each preset is a base model applied to every agent kind plus
   * per-kind overrides). One is the workspace default. Attached by the facade, so
   * optional on the wire.
   */
  modelPresets: v.optional(v.array(modelPresetSchema)),
  /**
   * The deployment's env-routing defaults as `provider:model` refs: the model an
   * agent kind runs on when neither the task nor the workspace pins one. `default`
   * is the global fallback; `byKind` carries the kinds an operator routed
   * specifically (e.g. a strong coding model for the coder). The frontend resolves
   * a kind's deployment default as `byKind[kind] ?? default` and labels it so the
   * model-defaults panel can name the model behind "Deployment default". Derived
   * from shared config, attached by the facade, so optional on the wire.
   */
  deploymentModelDefaults: v.optional(
    v.object({
      default: v.string(),
      byKind: v.record(v.string(), v.string()),
    }),
  ),
  /**
   * The workspace's default service-fragment selection (the best-practice fragment ids
   * new services inherit). Attached by the facade, so optional on the wire.
   */
  serviceFragmentDefaults: v.optional(serviceFragmentDefaultsSchema),
  /**
   * The workspace's recurring pipelines (schedules that re-run a pipeline against
   * a service on a cadence). Carried in the snapshot so the board renders the
   * recurring-task badges + inspector on load. Run history is fetched lazily.
   */
  recurringPipelines: v.optional(v.array(pipelineScheduleSchema)),
  /**
   * The workspace's issue-tracker selection (where the tech-debt pipeline files
   * its ticket). Attached by the worker, so optional on the wire.
   */
  trackerSettings: v.optional(trackerSettingsSchema),
  /**
   * In-org shared services. `mounts` are the services this workspace mounts (with the
   * per-workspace frame layout); `serviceCatalog` is the org's services the board can
   * mount from (each annotated with `mountCount` so the UI can badge a shared frame).
   * Attached by the worker when the services module is wired, so optional on the wire.
   */
  mounts: v.optional(v.array(workspaceMountSchema)),
  serviceCatalog: v.optional(v.array(serviceSchema)),
  /**
   * The workspace's runtime settings (the human-wait escalation threshold + the
   * per-service running-task limit policy). Lazily seeded from the defaults; attached
   * by the facade, so optional on the wire.
   */
  settings: v.optional(workspaceSettingsSchema),
  /**
   * Registered CUSTOM agent kinds (kind + presentation + container flag) a deployment
   * mixed in via `registerAgentKind`. The SPA merges these into its palette catalog so a
   * proprietary kind becomes a first-class palette block + result view instead of the
   * generic fallback. Static (process-global registry), workspace-independent; attached
   * by the facade, so optional on the wire and omitted when no custom kind is registered.
   */
  customAgentKinds: v.optional(v.array(customAgentKindSchema)),
  /**
   * The registered ephemeral-environment / runner-pool backend kinds (built-in + any a
   * deployment registered into the app-owned backend registries), each `{ kind, label }`. The
   * SPA drives the provider-connect backend-kind selector from these instead of a hardcoded
   * `manifest`/`kubernetes` list, so a registered custom backend becomes a first-class connect
   * option. Workspace-independent; attached by the facade `WorkspaceController`, which reads the
   * registries off the request container (the registries live in `@cat-factory/integrations`,
   * which the `workspaces` package doesn't depend on). Optional on the wire; the SPA falls back
   * to the built-ins when absent.
   */
  environmentBackendKinds: v.optional(v.array(backendKindOptionSchema)),
  runnerBackendKinds: v.optional(v.array(backendKindOptionSchema)),
  /**
   * Current built-in pipeline catalog versions (`seedPipelines()`), keyed by pipeline id. The
   * SPA compares each persisted built-in's `version` against this to detect a stale copy and
   * offer a reseed ("newer version available"). A persisted `version` below the catalog value
   * (or absent → treated as 0) means an update is available. Static, workspace-independent;
   * built by the shared `WorkspaceService.snapshot()` (so it is automatically symmetric across
   * runtimes), but optional on the wire for forward-compatibility.
   */
  pipelineCatalogVersions: v.optional(v.record(v.string(), v.number())),
  /**
   * Current built-in merge-preset catalog versions (`seedMergePresets()`), keyed by preset id.
   * The SPA compares each persisted built-in's `version` against this to detect a stale copy
   * (a newer definition is available) and a built-in id present here but absent from the
   * workspace's presets (a NEW built-in appeared), offering a reseed for either. Static,
   * workspace-independent; built by the shared `WorkspaceService.snapshot()` (automatically
   * symmetric across runtimes), optional on the wire for forward-compatibility.
   */
  mergePresetCatalogVersions: v.optional(v.record(v.string(), v.number())),
  /**
   * Current built-in model-preset catalog versions (`seedModelPresets()`), keyed by preset id.
   * The SPA compares each persisted built-in's `version` against this to detect a stale copy
   * (a newer definition is available) and a built-in id present here but absent from the
   * workspace's presets (a NEW built-in appeared), offering a reseed for either. Static,
   * workspace-independent; built by the shared `WorkspaceService.snapshot()` (automatically
   * symmetric across runtimes), optional on the wire for forward-compatibility.
   */
  modelPresetCatalogVersions: v.optional(v.record(v.string(), v.number())),
  /**
   * The workspace's initiatives (long-running multi-task bodies of work, each
   * anchored to an `initiative`-level block). Carried in the snapshot so the
   * board renders initiative cards + trackers on load. Attached by the facade
   * when the initiatives module is wired, so optional on the wire.
   */
  initiatives: v.optional(v.array(initiativeSchema)),
  /**
   * The registered INITIATIVE PRESETS (built-in `preset_generic` + any a deployment mixed in via
   * `registerInitiativePreset`), each a serialisable descriptor (form + planning-pipeline binding
   * + defaults + `probe` flag). The SPA's create-initiative picker renders these and starts the
   * chosen preset's `planningPipelineId`. Static (process-global registry), workspace-independent;
   * attached by the shared `WorkspaceController` (so it is symmetric across runtimes), optional on
   * the wire — the SPA falls back to the built-in generic pipeline when absent.
   */
  initiativePresets: v.optional(v.array(initiativePresetDescriptorSchema)),
  /**
   * Per-area infrastructure-setup status (ephemeral environments / agent executor / binary
   * storage), computed server-side from whatever THIS deployment wired — so the SPA can raise
   * a loud "configure your infra" banner when a workspace runs on a deployment that needs a
   * piece of infrastructure the operator hasn't defined yet. Runtime-symmetric by construction
   * (built in the shared `WorkspaceController` from the request container); optional on the
   * wire (absent on an older backend), the SPA then simply shows no banner.
   */
  infraSetup: v.optional(infraSetupSchema),
})
export type WorkspaceSnapshot = v.InferOutput<typeof workspaceSnapshotSchema>
