// @cat-factory/local-server — the local-mode runtime facade. It is the Node.js
// facade (@cat-factory/node-server: shared Hono app + Drizzle/Postgres + pg-boss)
// with two differentiators so a developer can run the whole product on their own
// machine: agent jobs run as per-job local Docker/Podman containers, and GitHub is
// reached via a personal access token (no GitHub App). `startLocal()` boots the
// service; `buildLocalContainer()` is the composition root.
export { startLocal } from './server.js'
export { buildLocalContainer } from './container.js'
export { loadLocalConfig, applyLocalDefaults } from './config.js'
export {
  LocalDockerRunnerTransport,
  createLocalDockerTransportFromEnv,
  type LocalDockerRunnerTransportOptions,
  type DockerExec,
} from './LocalDockerRunnerTransport.js'
// Seed the github_installations/github_repos projection so container agent steps can
// resolve a target repo in local mode (no GitHub App connect flow). Also a CLI:
// `node dist/link-repo.js <workspaceId> <frameBlockId> <owner/repo>`.
export { linkRepo, type LinkRepoOptions, type LinkedRepo } from './linkRepo.js'

// Installation-level extension points, re-exported for parity with the Node facade so
// a local deployment can register custom agent kinds / pipelines before `startLocal()`.
export {
  registerAgentKind,
  registerAgentKinds,
  clearRegisteredAgentKinds,
  type AgentKindDefinition,
} from '@cat-factory/agents'
export { registerPipeline, registerPipelines, clearRegisteredPipelines } from '@cat-factory/kernel'
