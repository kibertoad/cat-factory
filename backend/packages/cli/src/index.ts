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
export { bootstrap, type BootstrapDeps, BootstrapError } from './bootstrap.js'
export { type EnvCommandDeps, EnvCommandError, generateEnv } from './envCommand.js'
export { type FileSystem } from './fs.js'
export {
  type Command,
  COMMAND_NOT_FOUND,
  COMMAND_TIMED_OUT,
  createNodeShell,
  DEFAULT_COMMAND_TIMEOUT_MS,
  type HostShell,
  renderCommandLine,
  runCommand,
  type ShellResult,
} from './host-shell.js'
export { K3S_INSTALL_COMMAND, type K3sDeps, type K3sResult, setupK3s } from './k3s.js'
export {
  buildK3sHandler,
  buildK3sSetupUrl,
  DEFAULT_NAMESPACE_TEMPLATE,
  handlerLabel,
  type K3sHandlerInput,
  KUBERNETES_ENV_TOKEN_SECRET_KEY,
} from './k3s-handler.js'
// The three cluster READS, exported so other in-repo tooling asks the same questions of a
// kubeconfig that `cat-factory k3s` does: the acceptance suite's `configure` command resolves its
// apiserver URL and ServiceAccount token through these rather than restating the namespace and
// secret name, which would drift the moment the guided setup moved either.
export { decodeToken, readApiServerCommand, readTokenCommand } from './k3s-provision.js'
export {
  DEFAULT_INGRESS_PORT,
  INGRESS_HOST_TEMPLATE,
  type IngressReadiness,
  ingressHostTemplate,
  ingressUrlPort,
} from './k3s-ingress.js'
export {
  classifyHost,
  hasServerVersion,
  type HostDetections,
  type HostState,
  isRecreateOffer,
  type Offer,
  type OfferId,
  parseK3dClusters,
  parseKindClusters,
  probeHost,
  RECREATE_OFFERS,
  recreateOfferFor,
  recreateTargetForContext,
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
export {
  CONTAINER_RUNTIMES,
  type ContainerRuntime,
  EXECUTION_MODES,
  type ExecutionMode,
  HARNESS_IMAGE_EXAMPLE,
  HARNESS_IMAGE_GUIDANCE,
  harnessImageEnvLines,
  NATIVE_HARNESSES,
  type NativeHarness,
} from './templates.js'
export {
  EXECUTION_MODE_TRADEOFFS,
  NATIVE_HARNESS_INFO,
  type NativeHarnessInfo,
  type NativeModel,
  NATIVE_MODELS,
  nativeModelsFor,
  nativeModelSummary,
} from './execution.js'
export {
  githubPatCreationUrl,
  gitlabPatCreationUrl,
  patCreationUrl,
  patEnvVar,
  providerLabel,
  VCS_PROVIDERS,
  type VcsProvider,
} from './vcs.js'
