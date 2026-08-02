import { AsyncLocalStorage } from 'node:async_hooks'
import type { ResolveUserGitHubToken, RunCredentialScope } from '@cat-factory/kernel'

// Ambient "which credential does this run act with" context. It lets the engine GitHub client
// resolve the run initiator's per-user GitHub PAT WITHOUT threading a user id through the
// context-free `GitHubClient` / `CiStatusProvider` / `PullRequestMerger` ports: the engine
// (orchestration) wraps the gate-probe / merge call boundaries via the injected
// `RunInitiatorScope` (this `runWithInitiator`), and `PatPreferringAppRegistry` reads
// `currentCredentialScope()` to prefer that user's PAT over the deployment default.
//
// The scope carries the run's WORKSPACE alongside the initiator because whether the
// initiator's own token may be used at all is a per-workspace policy (`allowInitiatorPat`),
// and the GitHub client's own arguments name only an installation — which can serve several
// workspaces, so the policy could not be resolved back from it without guessing.
//
// Lives in the server package (which resolves `node:async_hooks`); the engine receives
// `runWithInitiator` as an injected seam so the runtime-neutral domain packages never
// import a node builtin. AsyncLocalStorage runs on Node and the Workers runtime.

interface InitiatorContext {
  scope: RunCredentialScope
  // Per-scope memo of the initiator's resolved PAT, keyed by user id. One
  // `runWithInitiator` scope is exactly one gate probe / merge boundary, so a probe that
  // fans out into several GitHub requests (e.g. the CI gate: branchHeadSha + listCheckRuns,
  // each re-minting via `request()`) resolves the PAT once — a single DB read + decrypt —
  // instead of once per request. The scope never outlives the freshness window of that
  // one call, so there is no staleness concern.
  tokenMemo?: Map<string, Promise<string | null>>
}

const storage = new AsyncLocalStorage<InitiatorContext>()

/** Run `fn` with the given run credential scope in ambient context (a `RunInitiatorScope`). */
export function runWithInitiator<T>(scope: RunCredentialScope, fn: () => T): T {
  return storage.run({ scope }, fn)
}

/** The current run's credential scope, if any code up the stack set one. */
export function currentCredentialScope(): RunCredentialScope | undefined {
  return storage.getStore()?.scope
}

/** The current run's initiator user id, if any code up the stack set one. */
export function currentInitiator(): string | undefined {
  return storage.getStore()?.scope.initiatedBy ?? undefined
}

/**
 * Resolve `initiatedBy`'s GitHub PAT through the ambient scope's per-call memo, so a gate
 * probe / merge that fans out into several GitHub requests pays a single `resolve` (DB read
 * + decrypt) rather than one per request. Outside any `runWithInitiator` scope it just
 * calls `resolve` directly (no caching — nothing to scope the memo to).
 *
 * Only the SUCCESS path is memoized: a rejected resolve is evicted so a transient failure
 * on the first request doesn't poison every later request in the scope (that would be a
 * regression vs. the old resolve-per-call behaviour).
 */
export function resolveInitiatorTokenCached(
  resolve: ResolveUserGitHubToken,
  initiatedBy: string,
): Promise<string | null> {
  const ctx = storage.getStore()
  if (!ctx) return resolve(initiatedBy)
  const memo = (ctx.tokenMemo ??= new Map())
  const cached = memo.get(initiatedBy)
  if (cached) return cached
  const pending = resolve(initiatedBy).catch((err) => {
    memo.delete(initiatedBy)
    throw err
  })
  memo.set(initiatedBy, pending)
  return pending
}
