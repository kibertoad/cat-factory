// @cat-factory/local-server — the local-mode runtime facade. It is the Node.js
// facade (@cat-factory/node-server: shared Hono app + Drizzle/Postgres + pg-boss)
// with two differentiators so a developer can run the whole product on their own
// machine: agent jobs run as per-run local containers (Docker/Podman/OrbStack/Colima/
// Apple `container`, selected by LOCAL_CONTAINER_RUNTIME), and GitHub is
// reached via a personal access token (no GitHub App). `startLocal()` boots the
// service; `buildLocalContainer()` is the composition root.
export { startLocal } from './server.js'
export { buildLocalContainer } from './container.js'
export { loadLocalConfig, applyLocalDefaults } from './config.js'
export {
  LocalContainerRunnerTransport,
  createLocalContainerTransportFromEnv,
  type LocalContainerRunnerTransportOptions,
} from './LocalContainerRunnerTransport.js'
export {
  type ContainerRuntimeAdapter,
  type ContainerExec,
  type RuntimeId,
  createRuntimeAdapter,
  resolveRuntimeId,
  runtimeProfile,
  resolveHostAlias,
  DockerRuntimeAdapter,
  AppleContainerRuntimeAdapter,
} from './runtimes/index.js'
// Seed the github_installations/github_repos projection so container agent steps can
// resolve a target repo in local mode (no GitHub App connect flow). Also a CLI:
// `node dist/link-repo.js <workspaceId> <frameBlockId> <owner/repo>`.
export { linkRepo, type LinkRepoOptions, type LinkedRepo } from './linkRepo.js'
// PAT-backed GitHub access for the CI gate + merge / mergeability providers.
export { createLocalGitHubClient, StaticTokenAppRegistry } from './github.js'

// Mothership mode: the local `node:sqlite` credential store (the agent/model secrets that
// stay on the laptop, sealed with the local key, while org/durable state lives on the
// mothership). See docs/initiatives/mothership-mode.md. Only the factory + its type are
// public; the raw db opener and the repo classes stay internal until the 1b composition
// step proves a consumer needs them.
export { createLocalCredentialStore, type LocalCredentialStore } from './sqlite/credentialStore.js'

// Installation-level extension points, re-exported for parity with the Node facade so
// a local deployment can register custom agent kinds / pipelines before `startLocal()`.
export {
  registerAgentKind,
  registerAgentKinds,
  clearRegisteredAgentKinds,
  type AgentKindDefinition,
} from '@cat-factory/agents'
export { registerPipeline, registerPipelines, clearRegisteredPipelines } from '@cat-factory/kernel'
