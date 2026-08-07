// Embeddable surface of the executor harness: the Pi-driving and git helpers
// the container payload uses, re-exported so other packages (e.g. the benchmark
// harness) can run the *same* coding-agent flow outside the container — clone a
// repo, write the agent context, point Pi at an OpenAI-compatible endpoint, run
// it, and inspect what changed. The HTTP server / job lifecycle stays internal;
// only the reusable primitives are exposed here.

export {
  writePiModelsConfig,
  writeAgentsContext,
  runPi,
  parseTodoProgress,
  type PiRunOutcome,
  type TodoItem,
  type TodoProgress,
} from './pi.js'
export {
  PI_MAX_OUTPUT_TOKENS,
  parsePiOutput,
  summarizePiRun,
  terminalRunError,
  type PiRunReduction,
  type PiRunStats,
} from './pi-reduction.js'
export {
  DEFAULT_PROGRESS_GUARD_LIMITS,
  progressGuardLimitsFromEnv,
  type ProgressGuardLimits,
} from './progress-guard.js'
export {
  cloneRepo,
  createBranch,
  changedPathsFromPorcelain,
  hasAgentChanges,
  redactSecrets,
} from './git.js'
export type { RepoSpec } from './job.js'
