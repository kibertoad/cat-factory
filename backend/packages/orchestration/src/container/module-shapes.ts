import type { BrainstormStage } from '@cat-factory/contracts'
import type {
  AccountSettingsService,
  PreflightService,
  SharedStackService,
  SlackConnectionService,
  SlackMemberMappingService,
  SlackSettingsService,
  TrackerWebhookService,
} from '@cat-factory/integrations'
import type { PackageRegistryService } from '../modules/packageRegistries/PackageRegistryService.js'
import type { BrainstormService } from '../modules/brainstorm/BrainstormService.js'
import type { ClarityReviewService } from '../modules/clarity/ClarityReviewService.js'
import type { IncidentEnrichmentService } from '../modules/incidentEnrichment/IncidentEnrichmentService.js'
import type { InitiativeLoopService } from '../modules/initiative/InitiativeLoopService.js'
import type { InitiativeService } from '../modules/initiative/InitiativeService.js'
import type { KaizenService } from '../modules/kaizen/KaizenService.js'
import type { MergeTrackRecordService } from '../modules/merge/MergeTrackRecordService.js'
import type { RiskPolicyService } from '../modules/merge/RiskPolicyService.js'
import type { NotificationService } from '../modules/notifications/NotificationService.js'
import type { PreviewService } from '../modules/preview/PreviewService.js'
import type { RecurringPipelineService } from '../modules/recurring/RecurringPipelineService.js'
import type { ReleaseHealthService } from '../modules/releaseHealth/ReleaseHealthService.js'
import type { RequirementReviewService } from '../modules/requirements/RequirementReviewService.js'
import type { SandboxRunService } from '../modules/sandbox/SandboxRunService.js'
import type { SandboxService } from '../modules/sandbox/SandboxService.js'
import type { ServiceFragmentDefaultsService } from '../modules/serviceFragmentDefaults/ServiceFragmentDefaultsService.js'
import type { AgentPromptService } from '../modules/agentPrompts/AgentPromptService.js'
import type { WorkspaceAgentSettingsService } from '../modules/agentSettings/WorkspaceAgentSettingsService.js'
import type { ModelPresetService } from '../modules/modelPresets/ModelPresetService.js'
import type { ConsensusGroupService } from '../modules/consensusGroups/ConsensusGroupService.js'
import type { TrackerSettingsService } from '../modules/recurring/TrackerSettingsService.js'
import type { TutorialProgressService } from '../modules/tutorial/TutorialProgressService.js'
import type { UserSettingsService } from '../modules/settings/UserSettingsService.js'
import type { WorkspaceSettingsService } from '../modules/settings/WorkspaceSettingsService.js'

// ---------------------------------------------------------------------------
// The SHAPES of the small optional modules the container assembles — one or a few
// services each, present only when their repositories/seams are wired. Pure type
// declarations with no logic, grouped here for file-size hygiene (`container.ts` is
// at its ratcheted budget) and re-exported from `container.ts` so every existing
// importer is unaffected. `container/modules.ts` — which builds them — imports from
// HERE rather than from `container.ts`, so the factories no longer carry a type-import
// back-edge onto the composition root.
//
// The two content-library shapes live beside their factories in
// `container-content-libraries.ts` instead; the bigger multi-collaborator shapes
// (GitHub / documents / tasks / environments / services) stay in `container.ts` next
// to the wiring that reads them.
// ---------------------------------------------------------------------------

/** The requirements-review feature's service, present only when its repository is wired. */
export interface RequirementsModule {
  service: RequirementReviewService
}

/** The Kaizen feature's service, present only when its repositories are wired. */
export interface KaizenModule {
  service: KaizenService
}

/** The clarity-review feature's service, present only when its repository is wired. */
export interface ClarityModule {
  service: ClarityReviewService
}

/** The brainstorm feature's per-stage services, present only when its repository is wired. */
export interface BrainstormModule {
  services: Record<BrainstormStage, BrainstormService>
}

/** The notifications feature's service, present only when its repository is wired. */
export interface NotificationsModule {
  service: NotificationService
}

/** The post-release-health (Datadog) settings service, present only when wired. */
export interface ReleaseHealthModule {
  service: ReleaseHealthService
}

/** The private package-registry settings service, present only when wired. */
export interface PackageRegistriesModule {
  service: PackageRegistryService
}

/** The browsable-frontend-preview service, present only when a preview transport is wired. */
export interface PreviewModule {
  service: PreviewService
}

/** The incident-enrichment (PagerDuty + incident.io) settings service, present only when wired. */
export interface IncidentEnrichmentModule {
  service: IncidentEnrichmentService
}

/** The per-account deployment-settings service, present only when wired (facade-built). */
export interface AccountSettingsModule {
  service: AccountSettingsService
}

/** The Slack integration's services, present only when its repositories are wired. */
export interface SlackModule {
  connectionService: SlackConnectionService
  settingsService: SlackSettingsService
  memberMappingService: SlackMemberMappingService
}

/** The merge-preset feature's service, present only when its repository is wired. */
export interface RiskPoliciesModule {
  service: RiskPolicyService
}

/**
 * The merge track-record feature's service, present only when its repository is wired. Carries
 * the change classification the per-class merge rules key off AND the persisted per-class
 * evidence (rollups + reviewer-effort tags) the preset editor reads.
 */
export interface MergeTrackRecordModule {
  service: MergeTrackRecordService
}

/** The shared-stacks feature's service, present only when its repository is wired. */
export interface SharedStacksModule {
  service: SharedStackService
}

/** The preflight feature's service, present only when the host-probe seam is wired (local facade). */
export interface PreflightsModule {
  service: PreflightService
}

/** The Sandbox feature's services, present only when its repositories are wired. */
export interface SandboxModule {
  /** Management CRUD (prompt versions, fixtures, experiments). */
  service: SandboxService
  /** The run-driver + judge (`launch` an experiment). */
  runService: SandboxRunService
}

/** The workspace-settings feature's service, present only when its repository is wired. */
export interface WorkspaceSettingsModule {
  service: WorkspaceSettingsService
}

/** The per-user-settings feature's service, present only when its repository is wired. */
export interface UserSettingsModule {
  service: UserSettingsService
}

/** Per-user in-app tutorial progress, present only when its repository is wired. */
export interface TutorialProgressModule {
  service: TutorialProgressService
}

/** The model-preset feature's service, present only when its repository is wired. */
export interface ModelPresetsModule {
  service: ModelPresetService
}

/** The consensus-group library's service, present only when its repository is wired. */
export interface ConsensusGroupsModule {
  service: ConsensusGroupService
}

/** The agent-prompt-override feature's service, present only when its repository is wired. */
export interface AgentPromptsModule {
  service: AgentPromptService
}

/** The per-agent-kind generation settings service, present only when its repository is wired. */
export interface WorkspaceAgentSettingsModule {
  service: WorkspaceAgentSettingsService
}

/** The default service-fragment feature's service, present only when its repository is wired. */
export interface ServiceFragmentDefaultsModule {
  service: ServiceFragmentDefaultsService
}

/** The recurring-pipeline feature's service, present only when its repository is wired. */
export interface RecurringModule {
  service: RecurringPipelineService
}

/**
 * Inbound tracker webhooks: what a verified, parsed delivery does (fire a qualifying intake
 * schedule / apply a ticket reply to a parked requirements review). Present only when the task
 * projection + connections are wired; the shared receiver 503s without it.
 */
export interface TrackerWebhookModule {
  service: TrackerWebhookService
}

/** The initiatives feature's service + execution loop, present only when its repository is wired. */
export interface InitiativesModule {
  service: InitiativeService
  /** The execution loop (slice 3): tick/runDue driven by the cron seams + terminal pokes. */
  loop: InitiativeLoopService
}

/** The issue-tracker-settings feature's service, present only when its repository is wired. */
export interface TrackerModule {
  service: TrackerSettingsService
}
