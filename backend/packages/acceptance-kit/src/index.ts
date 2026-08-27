// `@cat-factory/acceptance-kit`: what a headless acceptance suite against a LIVE deployment is made
// of, minus the suite.
//
// The platform's own acceptance suite (`backend/internal/acceptance`) is one consumer, and its
// scenarios are the shape this is meant for: adopt what a previous pass created, file work through
// `/api/v1`, drive the run, answer only the parks the suite was designed for, and assert on evidence
// the PLATFORM computed. A deployment covering its own providers, agent kinds or gates writes those
// scenarios and reuses everything under them.
//
// What is deliberately NOT here: the prerequisites (what a deployment must have wired is a fact about
// the pass), the scenarios, the configuration, and anything that asks a human for a credential. The
// seams for those are `Prerequisite`, `Scenario`, `SuiteIdentity` and `CredentialRetry`.

export { type BriefFields, type BriefOptions, briefFields } from './brief.js'
export {
  type ClientOptions,
  type CredentialRetry,
  createClient,
  createPassClient,
  type DeploymentTarget,
  describeDecisions,
  describeRun,
  describeStepTransitions,
  isTerminal,
  passThroughCredentialRetry,
  type StepObservation,
  stepObservations,
  waitForDecisionOrSettled,
} from './client.js'
export {
  type Probe,
  type ProbeResult,
  type ProbeTolerance,
  type WaitOptions,
  formatDuration,
  formatExpiry,
  formatOutage,
  waitFor,
} from './deadline.js'
export {
  type AnsweredDecision,
  type AnswerOptions,
  answerDecisions,
  clarityCapReached,
  isActionable,
  unexpectedDecision,
} from './decisions.js'
export {
  type ConfigProblem,
  DeploymentAnswerError,
  DeploymentApi,
  type DeploymentApiOptions,
  describeDeploymentFailure,
} from './deploymentApi.js'
export { DEPLOYMENT_OUTAGE_GRACE_MS, deploymentOutageTolerance } from './deploymentOutage.js'
export {
  type Check,
  assertChecks,
  check,
  checkCi,
  checkEphemeralEnvironment,
  checkMergeDecision,
  checkNotTruncated,
  checkReproductionProof,
  retainedEnvironmentUrl,
} from './evidence.js'
export { Journal, type JournalEvent, type JournalEventKind, readJournal } from './journal.js'
export {
  type LedgerFacts,
  type LedgerSlot,
  type LedgerSlots,
  LedgerStore,
  type PassOwnership,
  findPassesNaming,
  readLedger,
  recordsFacts,
  resolveRunId,
} from './ledger.js'
export {
  MAX_PRINTED_FAILURE_CHARS,
  OperatorRefusal,
  type ShellFlavour,
  assignFor,
  capped,
  describeFailure,
  describeThrown,
  envAssignment,
  failureWithLocation,
  perPersonAssignment,
  scrubbed,
  shellFlavour,
  shellLiteral,
  shellQuoted,
  shellWord,
  thrownLocation,
} from './operatorText.js'
export { type PassOptions, closingWords, describeStartupFailure, runPass } from './pass.js'
export {
  type LatestPointer,
  type PassOnDisk,
  type PassPaths,
  findMostRecentPass,
  latestPointerPath,
  listPasses,
  passPaths,
  readLatestPointer,
  readLatestRunId,
  resolveStateDir,
  writeLatestPointer,
} from './passFiles.js'
export {
  type PreflightOptions,
  type PreflightReport,
  type Prerequisite,
  type PrerequisiteDisposition,
  type PrerequisiteGate,
  type PrerequisiteResult,
  type PrerequisiteVerdict,
  type Remedy,
  type RemedyCommand,
  advisoryNotes,
  blockingResults,
  createPrerequisiteGate,
  formatPreflightFailure,
  formatPreflightLine,
  formatPrerequisiteFailure,
  formatRemedy,
  runPreflight,
  satisfied,
  unknown,
  unsatisfied,
} from './preflight.js'
export {
  type ProbeFailure,
  baseUrlStep,
  describeProbeFailure,
  probeFailureVerdict,
  transportChainText,
} from './probeFailure.js'
export {
  type FrameOutcome,
  type FrameReason,
  type FrameResult,
  type LeftoversContext,
  type PassResult,
  type PlannedFrame,
  type PlannedPass,
  type PlannedPointer,
  type PointerReason,
  type ResetBlocker,
  type ResetClient,
  type ResetFiles,
  type ResetInput,
  type ResetPassOnDisk,
  type ResetPlan,
  type ResetReport,
  type ResetServiceRow,
  type ResetTargeting,
  type ResetTaskRow,
  type TargetedFrame,
  applyReset,
  formatResetPlan,
  formatResetReport,
  parseResetArgs,
  planReset,
  resetSucceeded,
} from './reset.js'
export {
  type AcquireOptions,
  type AcquireResult,
  type ReclaimAllOptions,
  type ReclaimAllResult,
  type ReleaseOptions,
  type ReleaseResult,
  type ReleaseStatus,
  type ResourceRecord,
  acquire,
  reclaimAll,
  release,
} from './resource.js'
export {
  type FileAndDriveOptions,
  type FileAndDriveResult,
  type RunRecord,
  fileAndDrive,
} from './resume.js'
export { type DriveOptions, type DriveResult, driveRun, requireRunDone } from './runDriver.js'
export {
  GATE_STEP,
  type Scenario,
  type ScenarioFailure,
  type ScenarioOutcome,
  type ScenarioRunnerDeps,
  type ScenarioStep,
  failureReport,
  formatScenarioSummary,
  runScenarios,
  scenariosExitCode,
} from './scenarioRunner.js'
export {
  type SuiteIdentity,
  leftInPlaceNote,
  resumeCommand,
  suiteCommand,
} from './suiteIdentity.js'
