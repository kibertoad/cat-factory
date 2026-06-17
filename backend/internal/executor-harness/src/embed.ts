// Embeddable surface of the executor harness: the Pi-driving and git helpers
// the container payload uses, re-exported so other packages (e.g. the benchmark
// harness) can run the *same* coding-agent flow outside the container — clone a
// repo, write the agent context, point Pi at an OpenAI-compatible endpoint, run
// it, and inspect what changed. The HTTP server / job lifecycle stays internal;
// only the reusable primitives are exposed here.

export {
  PI_MAX_OUTPUT_TOKENS,
  writePiModelsConfig,
  writeAgentsContext,
  runPi,
  summarizePiRun,
  parsePiOutput,
  parseTodoProgress,
  type PiRunOutcome,
  type PiRunStats,
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
