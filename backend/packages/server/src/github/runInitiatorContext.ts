import { AsyncLocalStorage } from 'node:async_hooks'
import type { ResolveUserGitHubToken } from '@cat-factory/kernel'

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
  // Per-scope memo of the initiator's resolved PAT, keyed by user id. One
  // `runWithInitiator` scope is exactly one gate probe / merge boundary, so a probe that
  // fans out into several GitHub requests (e.g. the CI gate: listCommits + listCheckRuns,
  // each re-minting via `request()`) resolves the PAT once — a single DB read + decrypt —
  // instead of once per request. The scope never outlives the freshness window of that
  // one call, so there is no staleness concern.
  tokenMemo?: Map<string, Promise<string | null>>
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

/**
 * Resolve `initiatedBy`'s GitHub PAT through the ambient scope's per-call memo, so a gate
 * probe / merge that fans out into several GitHub requests pays a single `resolve` (DB read
 * + decrypt) rather than one per request. Outside any `runWithInitiator` scope it just
 * calls `resolve` directly (no caching — nothing to scope the memo to).
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
  const pending = resolve(initiatedBy)
  memo.set(initiatedBy, pending)
  return pending
}
