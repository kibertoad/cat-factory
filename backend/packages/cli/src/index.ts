// Public, programmatic API of @cat-factory/cli. The `cat-factory` command (bin.ts) is a thin
// shell over these; they are also exported so the bootstrap can be embedded in other tooling.
export {
  type CliOptions,
  HELP_TEXT,
  K3S_RUNTIMES,
  type K3sRuntime,
  OPTION_DEFAULTS,
  parseArgs,
  ArgError,
} from './args.js'
export { bootstrap, type BootstrapDeps, type FileSystem, BootstrapError } from './bootstrap.js'
export {
  COMMAND_NOT_FOUND,
  COMMAND_TIMED_OUT,
  createNodeShell,
  DEFAULT_COMMAND_TIMEOUT_MS,
  type HostShell,
  type ShellResult,
} from './host-shell.js'
export { K3S_INSTALL_COMMAND, type K3sDeps, type K3sResult, setupK3s } from './k3s.js'
export {
  classifyHost,
  hasServerVersion,
  type HostDetections,
  type HostState,
  type Offer,
  type OfferId,
  parseK3dClusters,
  parseKindClusters,
  probeHost,
  type ToolDetection,
} from './k3s-probe.js'
export {
  buildFrontendEnv,
  buildLocalEnv,
  type EnvEntry,
  type FrontendEnvInput,
  type LocalEnvInput,
  renderEnvFile,
} from './env.js'
export { buildGitignore, mergeGitignore, REQUIRED_GITIGNORE_RULES } from './gitignore.js'
export { type Io, createConsoleIo } from './io.js'
export { type BootstrapInput, buildPlan, type PlannedFile } from './plan.js'
export { generateSecrets, type GeneratedSecrets, type RandomBytes } from './secrets.js'
export { slugifyProjectName } from './slug.js'
export { CONTAINER_RUNTIMES, type ContainerRuntime, DEFAULT_HARNESS_IMAGE } from './templates.js'
export {
  githubPatCreationUrl,
  gitlabPatCreationUrl,
  patCreationUrl,
  patEnvVar,
  providerLabel,
  VCS_PROVIDERS,
  type VcsProvider,
} from './vcs.js'
