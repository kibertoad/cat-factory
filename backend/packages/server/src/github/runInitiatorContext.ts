import { AsyncLocalStorage } from 'node:async_hooks'
import type { RunCredentialScope } from '@cat-factory/kernel'

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
  // Per-scope memo of the run's resolved CREDENTIAL DECISION — the workspace policy read AND
  // the PAT decrypt behind it, not the decrypt alone. One `runWithInitiator` scope is exactly
  // one gate probe / merge boundary, so a probe that fans out into several GitHub requests
  // (e.g. the CI gate: four `installationToken` mints plus one `installationPermissions`, each
  // re-minting via `request()`) decides ONCE instead of five times. The scope never outlives
  // the freshness window of that one call, so there is no staleness concern.
  //
  // Memoizing the decrypt alone was not enough, and the gap was invisible on Node: the policy
  // read rides `AppCaches.workspaceSettings`, which the Worker used to run pass-through
  // (`enabled: false`, our own mutable state with no cross-isolate invalidation bus), so on
  // Cloudflare every un-memoized ask was a live D1 read, five per poll, for the whole life of
  // a PR's CI. The generation directory has since given that slice a real TTL on the coherent
  // profile, which shortens those reads but does not make this memo redundant: it still
  // collapses one boundary's fan-out to a single decision, and it is the only part that holds
  // on the pass-through profile a deployment without the `CACHE_GENERATIONS` binding still
  // runs. Keyed by the scope's identity fields rather than object identity, so a caller
  // that rebuilds an equal scope inside its own boundary still hits the memo.
  decisionMemo?: Map<string, Promise<string | null>>
}

/** The memo key for a scope: a run's credential decision is a function of exactly these two. */
function scopeKey(scope: RunCredentialScope): string {
  return `${scope.workspaceId}\u0000${scope.initiatedBy ?? ''}`
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

/**
 * Answer `decide(scope)` through the ambient scope's memo, so a gate probe / merge that fans
 * out into several GitHub requests decides the run's credential ONCE — one workspace-policy
 * read and at most one PAT decrypt — rather than once per request. Outside any
 * `runWithInitiator` scope it just calls `decide` directly (no caching — nothing to scope the
 * memo to), which is the container-dispatch mint's situation: one mint, one decision.
 *
 * Only the SUCCESS path is memoized: a rejected decision is evicted so a transient failure on
 * the first request doesn't poison every later request in the scope (that would be a
 * regression vs. the old decide-per-call behaviour). A `null` IS a success — it is the answer
 * "use the deployment credential", including the fail-closed answer for an unreadable policy,
 * and caching it is what makes an outage cost one settings read and one log line per probe
 * instead of five identical ones.
 */
export function resolveRunCredentialCached(
  decide: (scope: RunCredentialScope) => Promise<string | null>,
  scope: RunCredentialScope,
): Promise<string | null> {
  const ctx = storage.getStore()
  if (!ctx) return decide(scope)
  const memo = (ctx.decisionMemo ??= new Map())
  const key = scopeKey(scope)
  const cached = memo.get(key)
  if (cached) return cached
  const pending = decide(scope).catch((err) => {
    memo.delete(key)
    throw err
  })
  memo.set(key, pending)
  return pending
}
