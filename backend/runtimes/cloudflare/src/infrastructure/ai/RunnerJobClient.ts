// Moved to the runtime-neutral @cat-factory/server package (so the Node service
// drives container jobs through the same plumbing); re-exported here for existing
// Worker imports (the bootstrapper + the implementation executor).
export { RunnerJobClient, type ResolveRunnerTransport } from '@cat-factory/server'
