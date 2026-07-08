// Moved to the runtime-neutral @cat-factory/server package (so the Node service
// runs the same container agent executor, dispatching to its self-hosted runner
// pool); re-exported here for existing Worker imports.
export {
  ContainerAgentExecutor,
  type RepoTarget,
  type ResolveRepoTarget,
  type ResolveRepoTargets,
  type ResolveRunnerTransport,
} from '@cat-factory/server'
