// Embeddable surface of the executor harness: the Pi-driving and git helpers
// the container payload uses, re-exported so other packages (e.g. the benchmark
// harness) can run the *same* coding-agent flow outside the container — clone a
// repo, write the agent context, point Pi at an OpenAI-compatible endpoint, run
// it, and inspect what changed. The HTTP server / job lifecycle stays internal;
// only the reusable primitives are exposed here.

export {
  PI_MAX_OUTPUT_TOKENS,
  DEFAULT_PROGRESS_GUARD_LIMITS,
  writePiModelsConfig,
  writeAgentsContext,
  runPi,
  summarizePiRun,
  parsePiOutput,
  parseTodoProgress,
  progressGuardLimitsFromEnv,
  terminalRunError,
  type PiRunOutcome,
  type PiRunStats,
  type ProgressGuardLimits,
  type TodoItem,
  type TodoProgress,
} from './pi.js'
export {
  cloneRepo,
  createBranch,
  changedPathsFromPorcelain,
  hasAgentChanges,
  redactSecrets,
} from './git.js'
export type { RepoSpec } from './job.js'
