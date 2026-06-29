// Public, programmatic API of @cat-factory/cli. The `cat-factory` command (bin.ts) is a thin
// shell over these; they are also exported so the bootstrap can be embedded in other tooling.
export { type CliOptions, HELP_TEXT, OPTION_DEFAULTS, parseArgs, ArgError } from './args.js'
export { bootstrap, type BootstrapDeps, type FileSystem, BootstrapError } from './bootstrap.js'
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
export {
  githubPatCreationUrl,
  gitlabPatCreationUrl,
  patCreationUrl,
  patEnvVar,
  providerLabel,
  VCS_PROVIDERS,
  type VcsProvider,
} from './vcs.js'
