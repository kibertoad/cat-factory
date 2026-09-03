// The domain works directly with the wire entity types defined once in
// @cat-factory/contracts. Re-exported here so the rest of the core imports its
// vocabulary from a single place (`../domain/types`) rather than reaching into
// the contracts package everywhere.
export type {
  AgentKind,
  AgentState,
  AgentFailure,
  AgentFailureKind,
  AgentRunKind,
  ModelFamily,
  ModelFamilyPolicy,
  ModelPolicyMode,
  AccountRegion,
  ModelFamilyPolicyPreset,
  Block,
  BlockLevel,
  BlockStatus,
  BlockType,
  TaskType,
  CreateTaskType,
  TaskTypeFields,
  // The wire shape of a deployment-registered task type (the `TaskTypeRegistry`'s currency),
  // re-exported here so an org package registering one imports its whole vocabulary from kernel:
  // the descriptor, its field shape, and the shared form-value bag its answers land in.
  //
  // WHOLE means every member a registration literal names, the nested ones included. A list that
  // stops at the top-level shape is the failure this comment now guards: `TaskTypePresentation`
  // and `TaskTypeFieldOption` were absent while the doc promised the vocabulary, so a deployment
  // factoring its `presentation` out into a helper had to take a `@cat-factory/contracts`
  // dependency to name that helper's return type, which is exactly the direct dependency the
  // re-export exists to remove.
  CustomTaskType,
  TaskTypePresentation,
  TaskTypeFieldDescriptor,
  TaskTypeFieldType,
  TaskTypeFieldOption,
  // The SHARED descriptor vocabulary those narrow: an operation's fields and an initiative
  // preset's create form are the same shape, so a deployment authoring either names them here.
  DescriptorField,
  DescriptorFieldType,
  DescriptorFieldOption,
  DescriptorFieldShowWhen,
  DescriptorFieldValue,
  DescriptorFieldValues,
  DocKind,
  Decision,
  EnvConfigRepairJob,
  EnvConfigRepairStatus,
  EnvironmentTestRun,
  EnvironmentTestStage,
  EnvironmentTestStatus,
  ExecutionInstance,
  ExecutionStatus,
  IntakeOrigin,
  // The pre-dispatch input gate's wire vocabulary (see `domain/input-gate.ts` for its check).
  InputGateIssue,
  InputGateIssueCode,
  InputGateMode,
  InputGateSeverity,
  InputGateStatus,
  RunInputGate,
  ResolveInputGateChoice,
  ResolveInputGateRequest,
  Pipeline,
  PipelineAvailability,
  PipelineStep,
  Position,
  PriorStepOutput,
  PromptFragment,
  PullRequestRef,
  PeerPullRequest,
  ReferenceRepo,
  AprioriBranch,
  SpendStatus,
  StepApproval,
  StepReviewComment,
  ReviewCommentSeverity,
  StepSubtasks,
  WebSearchAvailability,
  WebSearchProvider,
  Workspace,
  WorkspaceSnapshot,
  // Prompt-fragment library shapes (ADR 0006).
  FragmentOwnerKind,
  FragmentTier,
  CreatePromptFragmentInput,
  CreateDocumentFragmentInput,
  UpdatePromptFragmentInput,
  FragmentSource,
  LinkFragmentSourceInput,
  FragmentSyncResult,
  FragmentSourceStatus,
  ResolvedFragment,
  ResolvedFragmentCatalog,
  // Account tenancy shapes.
  Account,
  AccountType,
  AccountRole,
  AccountMember,
  CreateAccountInput,
  AddMemberInput,
  // Workspace-level RBAC & membership shapes (the tier below account tenancy).
  WorkspaceRole,
  WorkspacePermission,
  WorkspaceAccessMode,
  WorkspaceMember,
  // In-org shared services (account-owned services + per-workspace mounts).
  Service,
  WorkspaceMount,
  MountServiceInput,
  UpdateMountInput,
  // GitHub integration projections + I/O shapes.
  GitHubBranch,
  GitHubCheckRun,
  GitHubCommit,
  GitHubConnection,
  GitHubInstallationOption,
  GitHubAvailableRepo,
  GitHubIssue,
  GitHubIssueState,
  GitHubPullRequest,
  GitHubPullRequestState,
  OpenedPullRequest,
  GitHubRepo,
  RepoTreeEntry,
  SetRepoMonorepoInput,
  CommitFilesInput,
  LinkReposInput,
  OpenPullRequestInput,
  MergePullRequestInput,
  // Shared provider self-description + connection-test shapes.
  ProviderConfigFieldType,
  ProviderConfigField,
  ProviderDescriptor,
  ConnectionTestResult,
  ConnectionWarning,
  ConnectionWarningCode,
  // Per-user secret (generic, kind-discriminated) shapes.
  UserSecretKind,
  UserSecretStatus,
  StoreUserSecretInput,
  TestUserSecretInput,
  UserSecretDescriptor,
  // Document-source integration projections + planning shapes.
  DocumentSourceKind,
  DocumentOrigin,
  DocumentLinkRole,
  DocumentRenderStatus,
  DocumentSourceDescriptor,
  CredentialField,
  DocumentConnection,
  SourceDocument,
  DocumentSearchResult,
  DocumentBoardPlan,
  PlanFrame,
  PlanModule,
  PlanTask,
  // Task-source integration projections + I/O shapes.
  TaskSourceKind,
  TaskSourceDescriptor,
  TaskSourceState,
  TaskSourceDiagnostic,
  TaskSourceDiagnosticStatus,
  TaskConnection,
  TaskComment,
  TaskDependencyLink,
  SourceTask,
  TaskSearchResult,
  IssueIntakePredicate,
  // Bug hunt: the interactive dual of the recurring `bug-intake` step.
  TrackerBoard,
  BugCandidate,
  BugHuntAnalysis,
  BugHuntAnalysisStatus,
  BugHuntCandidate,
  BugHuntConfidence,
  BugHuntResult,
  RunBugHuntInput,
  // Ephemeral environment provider shapes.
  EnvironmentSecretRef,
  EnvironmentAuthScheme,
  EnvironmentHttpMethod,
  EnvironmentRequestTemplate,
  EnvironmentStatus,
  // What an independent probe found after a teardown call succeeded — the difference between
  // the provider accepting the destroy request and the environment actually being gone.
  TeardownConfirmation,
  EnvironmentAccessScheme,
  EnvironmentAccessMapping,
  EnvironmentResponseMapping,
  EnvironmentManifest,
  // The universal environment-backend discriminated config + the Kubernetes backend.
  EnvironmentBackendConfig,
  EnvironmentBackendKind,
  KubernetesEnvironmentConfig,
  // What it takes to REACH a cluster, as opposed to what it takes to stand an environment up
  // in one: the reclaim path validates only this, so drift in the provisioning half of a
  // stored config can never strand a live namespace.
  KubernetesConnectionConfig,
  KubernetesManifestSource,
  KubernetesUrlSource,
  KubernetesRenderer,
  KubernetesImageOverride,
  KubernetesHelmRelease,
  KubernetesHelmSet,
  KubernetesSecretEntry,
  KubernetesSecretInjection,
  KubernetesProvisionConfig,
  // Cloudflare Workers preview (per-PR Worker, driven over the VCS deployments API).
  CloudflareEnvironmentConfig,
  CloudflareConnectionConfig,
  // Per-service provision type + per-type infra handlers (the what/where ÷ how split).
  ProvisionType,
  EnvironmentFailureReason,
  InfraEngine,
  ManifestId,
  ServiceProvisioning,
  // Docker Compose stack recipes (the complex-monolith bring-up expressed as data).
  StackRecipe,
  RecipeStep,
  RecipeStepKind,
  RecipeHealthGate,
  RecipeEnvFile,
  // Preflights (machine-prerequisite checks with guided remediation).
  PreflightCheckId,
  PreflightParams,
  PreflightRef,
  PreflightStatus,
  PreflightResult,
  // Frontend-frame config (build/serve/mock knobs + backend bindings that double as links).
  FrontendConfig,
  FrontendBackendBinding,
  FrontendBackendSource,
  // Frontend backend-binding resolution (shared pure helpers' types).
  ResolvedFrontendBinding,
  LiveEnvHandle,
  // Directed service→service connections (stored on the consumer frame).
  ServiceConnection,
  KubernetesEngineConfig,
  InfraHandlerConfig,
  CustomManifestType,
  CustomManifestTypeSource,
  UpsertCustomManifestTypeInput,
  EnvironmentAccessHandle,
  EnvironmentHandle,
  // Whether a `ready` environment can be REACHED, which is a different question from whether it
  // was provisioned: the addresses its provider states for its URL host, and what dialling them
  // proved.
  EnvironmentRouteCandidate,
  StatedRouteTarget,
  EnvironmentReachability,
  EnvironmentReachabilityNote,
  EnvironmentRouteAttempt,
  EnvironmentRouteProof,
  EnvironmentUnreachableReason,
  EnvironmentConnection,
  TestEnvironmentConnectionInput,
  TestEnvironmentHandlerInput,
  ValidateEnvironmentRepoInput,
  BootstrapEnvironmentRepoInput,
  BootstrapRepoResult,
  // Sensitive per-service test credentials (sealed; delivered out-of-band to the Tester).
  TestSecretRef,
  TestSecretEntry,
  ServiceTestSecretsView,
  UpsertServiceTestSecretsInput,
  // Unified provisioning event-log shapes.
  ProvisioningSubsystem,
  ProvisioningOperation,
  ProvisioningOutcome,
  ProvisioningLogEntry,
  // Self-hosted runner-pool ("bring your own infra") shapes.
  RunnerPoolSecretRef,
  RunnerPoolAuthScheme,
  RunnerPoolRequestTemplate,
  RunnerJobState,
  RunnerPoolResponseMapping,
  RunnerPoolManifest,
  RunnerPoolConnection,
  TestRunnerPoolConnectionInput,
  // The universal runner-backend discriminated config + the Kubernetes backend.
  RunnerBackendConfig,
  RunnerBackendKind,
  KubernetesRunnerConfig,
  KubernetesResourceQuantities,
  // Repo-bootstrap shapes.
  ReferenceArchitecture,
  CreateReferenceArchitectureInput,
  UpdateReferenceArchitectureInput,
  BootstrapStatus,
  BootstrapPhase,
  BootstrapDelivery,
  BootstrapFailure,
  BootstrapFailureKind,
  BootstrapJob,
  MonorepoBootstrapTarget,
  MonorepoBootstrapRef,
  AdoptionArea,
  AdoptionSource,
  AdoptionDecision,
  AdoptionSurvey,
  AdoptionPlan,
  AdoptionPlanUnavailableReason,
  AdoptionChoice,
  AdoptionReviewInput,
  ResolvedAdoption,
  ResolvedAdoptionDecision,
  BootstrapRepoInput,
  // Service-blueprint (repository decomposition) shapes — produced by the
  // `blueprints` pipeline step and reconciled onto the board.
  BlueprintModule,
  BlueprintService,
  BlueprintSource,
  BoardScanSpawnResult,
  // Requirements-review (stateless context reviewer agent) shapes.
  ReviewItemCategory,
  ReviewItemSeverity,
  ReviewItemStatus,
  RequirementReviewItem,
  RequirementReviewStatus,
  RequirementReview,
  // Interactive document-interview session shapes (WS5 of the document-task track).
  DocInterviewQa,
  DocInterviewStatus,
  DocInterviewSession,
  AnswerDocInterviewInput,
  // Kaizen (post-run grading agent) shapes.
  KaizenGradingStatus,
  KaizenGrading,
  KaizenVerifiedCombo,
  KaizenOverview,
  KaizenRunGradings,
  RecommendationStatus,
  RequirementRecommendation,
  ReplyReviewItemInput,
  UpdateReviewItemStatusInput,
  IncorporateRequirementsInput,
  RequestRecommendationItem,
  RequestRecommendationsInput,
  ReRequestRecommendationInput,
  ResolveRequirementsExceededInput,
  ResolveRequirementsExceededChoice,
  // Follow-up companion (future-looking Coder) shapes: surfaced loose-end / question items
  // + the live step state the engine parks/loops on.
  FollowUpItemKind,
  FollowUpItemStatus,
  FollowUpResolution,
  FollowUpItem,
  FollowUpsStepState,
  AnswerFollowUpInput,
  StreamedFollowUp,
  // Implementation-fork decision shapes: the materially different approaches the proposer
  // surfaces + the live step state the engine parks/loops on + the human's choice.
  ForkOption,
  ForkChatMessage,
  ForkDecisionStatus,
  ForkChoice,
  ForkDecisionStepState,
  ForkChatRequestInput,
  ChooseForkInput,
  ForkProposal,
  // Generated-candidate comparison shapes on a binary-output step: the candidates a first pass
  // stages, the live step state the engine parks on, and the human's keep/discard decision.
  BinaryCandidate,
  BinaryCandidateComparison,
  BinaryCandidateChoice,
  BinaryCandidateKeep,
  BinaryCandidateNoChoiceReason,
  BinaryCandidateStatus,
  BinaryCandidateStepState,
  KeepBinaryCandidatesInput,
  // Generative-integration capability shapes: what an integration can be ASKED FOR while
  // generating, and the per-step generation options each capability unlocks.
  BinaryGeneratorCapability,
  BinaryGenerationOptions,
  BinaryAssetRef,
  BinaryReferenceImage,
  // Judge shapes (the fourth step-taxonomy bucket): the rubric verdict an assessment
  // returns + the live step state the engine parks/bounces on + the human's resolution.
  JudgeFindingSeverity,
  JudgeFinding,
  JudgeVerdict,
  JudgeDisposition,
  JudgeStatus,
  JudgeRound,
  JudgeStepState,
  JudgeModelPin,
  JudgeModelPinStatus,
  ResolveJudgeInput,
  // PR deep-review shapes: the sliced, severity-ordered findings the read-only reviewer
  // produces + the live step state the engine parks on + the human's selection/resolution.
  PrReviewSeverity,
  PrReviewCategory,
  PrReviewSlice,
  // The live per-slice reviews captured WHILE the reviewer runs, which is what makes a review's
  // finished slices durable before its aggregation pass returns (and resumable when it doesn't).
  PrReviewSliceReview,
  PrReviewFinding,
  PrReviewFindingChallenge,
  PrReviewStatus,
  PrReviewResolution,
  PrReviewStepState,
  PrReviewPostReport,
  PrReviewPostFailure,
  PrReviewAgentOutput,
  PrReviewChallengeOutput,
  ResolvePrReviewInput,
  ChallengePrReviewFindingInput,
  // Clarity-review (bug-report triage reviewer agent) shapes — reuse the requirements
  // review item/status shapes, differ only in subject + the persisted document field.
  ClarityReviewItem,
  ClarityReviewStatus,
  ClarityReview,
  ReplyClarityItemInput,
  UpdateClarityItemStatusInput,
  IncorporateClarityInput,
  ResolveClarityExceededInput,
  ResolveClarityExceededChoice,
  // Brainstorm (structured-dialogue agent) shapes — reuse the requirements review
  // item/status shapes, differ in the `stage` discriminator + the converged-direction doc.
  BrainstormStage,
  BrainstormItem,
  BrainstormStatus,
  BrainstormSession,
  ReplyBrainstormItemInput,
  UpdateBrainstormItemStatusInput,
  IncorporateBrainstormInput,
  ResolveBrainstormExceededInput,
  ResolveBrainstormExceededChoice,
  // Shared iterative-gate cap resolution (requirements reviewer + quality companions).
  IterationCapChoice,
  ResolveIterationCapInput,
  // Structured in-repo specification (sharded module → group tree) shapes.
  RequirementPriority,
  RequirementKind,
  /** Implementation state: agreed-but-not-built vs observed-to-hold. */
  RequirementState,
  AcceptanceCriterion,
  RequirementItem,
  DomainRule,
  RequirementGroup,
  SpecModule,
  SpecDoc,
  // Companion-agent shapes: the raw model assessment + the standardized stored verdict.
  CompanionAssessment,
  CompanionVerdict,
  // Gate (ci/conflicts) / merge-policy shapes.
  // Deploy-remediation shapes (the deployer bounded fixer loop).
  DeployFixConfig,
  DeployFixState,
  DeployFixAttempt,
  GateStepState,
  GateFailingCheck,
  GateAttempt,
  // Ralph-loop shapes (persistent retry-until-done step state + iteration verdict).
  RalphStepState,
  RalphVerdict,
  RalphAttempt,
  // Pre-PR validation shapes (per-service check commands + the harness's report).
  ValidationCheck,
  ValidationCheckOutcome,
  ValidationReport,
  ResolvedValidationChecks,
  ServiceValidationConfig,
  UpsertServiceValidationConfigInput,
  // Bugfix reproduction-proof shapes (the resolved spec + the harness's report).
  ReproductionProofMode,
  ResolvedReproduction,
  ReproductionStatus,
  ReproductionPhaseOutcome,
  ReproductionReport,
  // Human-testing gate shapes (ephemeral env + human validation loop).
  HumanTestStepState,
  HumanTestEnvironment,
  HumanTestRound,
  RequestHumanTestFixInput,
  // Visual-confirmation gate shapes (screenshot review + fix loop).
  VisualConfirmStepState,
  VisualConfirmPair,
  VisualConfirmReferenceOrigin,
  VisualConfirmDesignGap,
  VisualConfirmDesignGapReason,
  VisualConfirmDesignReferences,
  VisualConfirmRound,
  MergeAssessment,
  MergeAxis,
  MergeDecision,
  MergeDecisionThresholds,
  MergeClassRule,
  MergeClassRules,
  // Role-scoped narrowing of the per-class rules, the per-role allowlist of landable classes,
  // and the sandboxed run mode.
  ClassRulesByRole,
  SubmissionClassesByRole,
  RunMode,
  // Merge track record (per-class human evidence behind the auto-merge policy).
  ChangeClass,
  ReviewEffort,
  MergeTrackDecision,
  MergeTrackRecord,
  MergeClassRollup,
  ReviewEffortDistribution,
  TagReviewEffortInput,
  // The engine-maintained PR verification report (composed by orchestration, published
  // through the `PrVerificationReportPublisher` port).
  PrVerificationReport,
  // Which of a multi-repo run's pull requests a given copy of the report is written onto, and
  // the own-service PR a peer's copy points back at for the sections it withholds.
  PrReportScope,
  PrReportOwnPullRequest,
  PrReportSectionStatus,
  PrReportStep,
  PrReportIssue,
  PrReportJudge,
  // What the Coder flagged mid-run and how each item was decided.
  PrReportFollowUp,
  PrReportFollowUps,
  PrReportRun,
  PrReportCheck,
  PrReportCi,
  PrReportTestOutcome,
  PrReportTestConcern,
  PrReportTests,
  // What the run built FROM: the linked documents its dispatches read, at which revision.
  PrReportContext,
  PrReportContextDocument,
  // Captured command output: the platform's own pre-PR check run, and the bugfix
  // reproduction proof across the pre-fix and final trees.
  PrReportValidation,
  PrReportValidationCommand,
  PrReportReproduction,
  PrReportReproductionPhase,
  PrReportEnvironment,
  PrReportEnvironments,
  // The environment-lifecycle proof: the dated up/down timeline plus the evidence captured
  // from the environment while it was live.
  PrReportEnvironmentTimeline,
  PrReportTimelineGap,
  PrReportEnvironmentEvidence,
  PrReportEvidenceArtifact,
  // Requirement → evidence: the spec's requirements joined to the tester's verdicts.
  PrReportRequirement,
  PrReportRequirements,
  PrReportMerge,
  PrReportObservability,
  RiskPolicy,
  RequirementConcernLevel,
  CreateRiskPolicyInput,
  UpdateRiskPolicyInput,
  CloneRiskPolicyInput,
  // The two tiers a risk policy can be stored at, the merged library entry a board picks from,
  // and one account policy a board is hiding.
  RiskPolicyTier,
  RiskPolicyLibraryEntry,
  RiskPolicySuppression,
  // Whether a policy answers a run's own automatic-loop caps, and which of a workspace's two
  // default policies a run resolves when its task pinned none.
  RunAutonomy,
  RunDefaultScope,
  // Where one ordered `-f` compose layer's text comes from: a path in the primary repo, a
  // directly-supplied document, or a path in another repo.
  ComposeFileRef,
  ComposeSource,
  ComposeSourceKind,
  // Shared stacks (long-lived compose infra a consumer environment attaches to).
  SharedStack,
  SharedStackStatus,
  CreateSharedStackInput,
  UpdateSharedStackInput,
  DetectSharedStackInput,
  SharedStackRecommendation,
  // Consensus-orchestration shapes (optional `@cat-factory/consensus` mechanism)
  // + the core task-estimator triage that gates it.
  ConsensusStrategy,
  ConsensusParticipant,
  ConsensusGating,
  StepGating,
  ConsensusStepConfig,
  // The reusable, estimate-gated panel library a step's `groupIds` escalate to.
  ConsensusGroup,
  CreateConsensusGroupInput,
  UpdateConsensusGroupInput,
  TaskEstimate,
  // The estimate's two producers and the record one leaves behind when it corrects the other:
  // the basis vocabulary and the superseded-scores shape travel WITH `TaskEstimate`, or a caller
  // composing one has to reach into contracts for half of it.
  TaskEstimateBasis,
  SupersededTaskEstimate,
  ConsensusScore,
  ConsensusContribution,
  ConsensusRound,
  ConsensusSessionStatus,
  ConsensusSession,
  // Agent config-contribution shapes.
  AgentConfigOption,
  AgentConfigDescriptor,
  AgentConfigCatalog,
  AgentConfigValues,
  // Tester / Fixer structured-report shapes.
  TestReport,
  TestOutcome,
  TestConcern,
  TestConcernSeverity,
  // Per-spec-requirement verdicts, keyed by the spec's own requirement ids.
  RequirementVerdict,
  RequirementVerdictStatus,
  // Test quality-control companion (per-Tester-step) config.
  TesterQualityConfig,
  // Extensible per-step options bag (the new home for per-step pipeline parameters).
  StepOptions,
  // Per-step gate configuration: who may resolve a human gate and how many of them, plus the
  // parameters of the registered gate the step's kind runs.
  StepGateConfig,
  GateApproverPolicy,
  GateApprovalRecord,
  // Container provisioning vocabulary.
  CloudProvider,
  InstanceSize,
  UpdateAccountInput,
  // Per-workspace model presets (named model→agent mappings; a task picks one) plus the route
  // vocabulary a preset's `providerPreference` orders.
  ModelFlavor,
  ModelPreset,
  CreateModelPresetInput,
  UpdateModelPresetInput,
  // Per-workspace agent system-prompt overrides (an append-only revision log per kind).
  AgentPromptRevision,
  AgentPromptDetail,
  AgentPromptSummary,
  SaveAgentPromptInput,
  PromoteAgentPromptInput,
  // Per-workspace, per-agent-kind generation settings (the output-token ceiling).
  WorkspaceAgentSettings,
  UpdateWorkspaceAgentSettingsInput,
  // Per-workspace default service-fragment selection (new services inherit it).
  ServiceFragmentDefaults,
  SetServiceFragmentDefaultsInput,
  // Notification shapes.
  Notification,
  NotificationType,
  NotificationStatus,
  NotificationSeverity,
  NotificationPayload,
  ResolveNotificationAction,
  // The notification manager: which types a workspace delivers on which channel.
  NotificationDeliveryChannel,
  NotificationChannelOverrides,
  NotificationRoutingMatrix,
  NotificationSettings,
  UpdateNotificationSettingsInput,
  // Per-workspace runtime settings (human-wait escalation threshold + task limits).
  WorkspaceSettings,
  UpdateWorkspaceSettingsInput,
  TaskLimitMode,
  TaskLimitPerType,
  // Per-user settings (the user-tier spend budget).
  UserSettings,
  UpdateUserSettingsInput,
  // Per-user in-app tutorial progress + the funnel event vocabulary.
  TutorialProgress,
  TutorialDecision,
  UpdateTutorialProgressInput,
  TutorialEvent,
  RecordTutorialEventInput,
  // Slack integration shapes (Slack as an extra notification transport).
  SlackConnection,
  SlackRoute,
  SlackNotificationSettings,
  SlackMemberMappingEntry,
  SlackMemberRole,
  SlackMemberMapping,
  SlackChannel,
  ConnectSlackByTokenInput,
  UpdateSlackSettingsInput,
  UpdateSlackMemberMappingInput,
  // Recurring-pipeline (scheduled run) shapes.
  ScheduleTemplate,
  Recurrence,
  IssueIntakeConfig,
  PipelineSchedule,
  ScheduleRun,
  CreateScheduleInput,
  UpdateScheduleInput,
  // Issue-tracker selection shapes.
  TrackerKind,
  TrackerSettings,
  PutTrackerSettingsInput,
  WritebackOverride,
  // LLM observability: the compact per-call summary pushed over the event stream.
  LlmCallActivity,
  // Sandbox (parallel prompt/model testing surface) shapes.
  SandboxPromptOrigin,
  SandboxPromptVersion,
  SandboxFixtureKind,
  SandboxRepoRef,
  SandboxFixtureObjective,
  SandboxFixture,
  SandboxExperimentStatus,
  SandboxMatrix,
  SandboxExperiment,
  SandboxRunStatus,
  SandboxTokenUsage,
  SandboxRun,
  SandboxGradeDimension,
  SandboxObjectiveResult,
  SandboxGrade,
  // Initiative (long-running multi-task work container) shapes.
  Initiative,
  InitiativeStatus,
  InitiativeItem,
  InitiativeItemStatus,
  InitiativePhase,
  InitiativeEstimate,
  InitiativePipelineRule,
  InitiativeExecutionPolicy,
  InitiativeDecision,
  InitiativeDeviation,
  InitiativeFollowUp,
  InitiativeQa,
  InitiativeQaStatus,
  InitiativeInterviewState,
  InitiativePlanDraft,
  InitiativeDraftItem,
  InitiativeVersion,
  CreateInitiativeInput,
  AnswerInitiativeQuestionInput,
  PromoteInitiativeFollowUpInput,
  UpdateInitiativeItemInput,
  UpdateInitiativePolicyInput,
  AccountSettingsConfig,
  ContentStorageConfig,
  FigmaOAuthSecret,
  LinearOAuthSecret,
  S3CredentialsSecret,
  SlackOAuthSecret,
  WebSearchSecret,
} from '@cat-factory/contracts'

/**
 * A backend-prepared file to inject into a container agent's `.cat-context/` directory before
 * it runs — the deterministic analogue of the linked-doc context the executor already
 * materialises. A preOp returns these on {@link RepoOpResult.contextFiles}; the engine surfaces
 * them on {@link AgentRunContext.injectedContextFiles} and the executor folds them into the
 * dispatched job's context files. `path` is the file name under `.cat-context/`; `content` is
 * its full UTF-8 text. Kept in the shared domain vocabulary so both the port (`agent-definition`)
 * and the run context (`agent-executor`) reference one shape without a circular import.
 */
export interface InjectedContextFile {
  path: string
  content: string
}

/**
 * One reference design image the platform holds for a run's task, named for delivery INTO the
 * container: the UI tester reads these off disk under `.cat-context/reference-screenshots/` and
 * captures the matching views, so the gate it feeds pairs actual-vs-reference by name.
 *
 * The bytes do NOT ride this shape, and that is the point: a design frame is a full-page PNG and
 * a run's set of them is megabytes, while a job body is JSON that crosses every transport and is
 * persisted with the dispatch. Only the artifact's IDENTITY travels, and the harness fetches the
 * bytes back through the same container-session-authed seam the tester already uploads through.
 *
 * `view` is the pairing key (the gate's own view name, qualified when two designs claim one
 * name); `fileName` is the single safe path segment that view is written under, resolved by the
 * engine rather than the container so the name the agent sees is the name the gate recorded.
 */
export interface ReferenceScreenshot {
  view: string
  artifactId: string
  fileName: string
}

/**
 * A capturing dispatch's whole reference answer: the files it is handed, and the views it is NOT.
 *
 * The second half exists because the set is CAPPED. A task can hold far more references than one
 * run should spend its pre-run budget downloading (a block may carry a hundred uploads beside a
 * design's frames), so the engine sends a bounded prefix of them. A cap that simply shortened the
 * list would be the silent kind: on disk a view nobody mentioned and a screen the design does not
 * have are the same absence, so the agent would never learn those views exist and the gate would
 * later pair against captures nobody was asked for.
 *
 * So the dropped views are NAMED here and stated to the agent, which still captures them under
 * their own names with no image to compare against — exactly the disposition a reference that
 * failed to transfer already gets.
 */
export interface ReferenceScreenshotSet {
  /** The references this run is handed, in the gallery order the set was resolved in. */
  files: ReferenceScreenshot[]
  /** The view names the cap dropped, in that same order. Empty when nothing was dropped. */
  omitted: string[]
}

/**
 * One picture of a task's design, named for delivery to the MODEL rather than to a capture.
 *
 * The sibling of {@link ReferenceScreenshot}, and the distinction between them is the
 * DISPOSITION, not the artifact: both are drawn from the same reference set (an import's retained
 * frames plus a person's uploads), but a capturing kind reads them off disk to compare its own
 * screenshots against, while a BUILDING kind is meant to look at them. Kept as its own shape
 * because that consumer needs the stored content type (an inline caller hands the bytes to the
 * model with their media type, which a file path never carries) and because folding the two would
 * make every later field on one of them arrive on the other for no reason.
 *
 * Bytes do not ride this shape, for the same reason they do not ride the capture manifest: a job
 * body is JSON that crosses every transport and is persisted with the dispatch, and an agent
 * context is snapshotted. Only the artifact's IDENTITY travels; each delivery path fetches the
 * bytes through the seam it already holds a credential for.
 */
export interface DesignImage {
  /** The view this picture is of, in the same vocabulary the visual-confirmation gate pairs on. */
  view: string
  artifactId: string
  /** The stored image's MIME type: the media type an inline attachment declares. */
  contentType: string
  /** The single safe path segment a container delivery writes this view under. */
  fileName: string
}

/**
 * The design pictures resolved for one dispatch, and the views it is NOT given.
 *
 * `omitted` exists because the set is CAPPED far tighter than the capture set: every attached image
 * spends input tokens on every turn, so a run is handed the few that inform the work rather than a
 * design system's whole frame list. A cap that merely shortened the list would be the silent kind,
 * since a screen nobody mentioned and a screen the design does not have look identical from inside
 * the run.
 */
export interface DesignImageSet {
  /** The pictures this dispatch is handed, in the order the reference set was resolved in. */
  files: DesignImage[]
  /** The view names the cap dropped, in that same order. Empty when nothing was dropped. */
  omitted: string[]
}
