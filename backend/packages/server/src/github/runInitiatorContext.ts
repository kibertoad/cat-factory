import { AsyncLocalStorage } from 'node:async_hooks'

// Ambient "who initiated this run" context. It lets the engine GitHub client resolve
// the run initiator's per-user GitHub PAT WITHOUT threading a user id through the
// context-free `GitHubClient` / `CiStatusProvider` / `PullRequestMerger` ports: the
// engine (orchestration) wraps the gate-probe / merge call boundaries via the injected
// `RunInitiatorScope` (this `runWithInitiator`), and `PatPreferringAppRegistry` reads
// `currentInitiator()` to prefer that user's PAT over the deployment default.
//
// Lives in the server package (which resolves `node:async_hooks`); the engine receives
// `runWithInitiator` as an injected seam so the runtime-neutral domain packages never
// import a node builtin. AsyncLocalStorage runs on Node and the Workers runtime.

interface InitiatorContext {
  initiatedBy?: string
}

const storage = new AsyncLocalStorage<InitiatorContext>()

/** Run `fn` with the given run initiator in ambient context (a `RunInitiatorScope`). */
export function runWithInitiator<T>(initiatedBy: string | null | undefined, fn: () => T): T {
  return storage.run({ initiatedBy: initiatedBy ?? undefined }, fn)
}

/** The current run's initiator user id, if any code up the stack set it. */
export function currentInitiator(): string | undefined {
  return storage.getStore()?.initiatedBy
}
