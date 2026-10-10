// The ONE answer to "have we already minted this installation token?", shared by the two
// sources that mint one: `GitHubAppAuth` (the App key, on a hosted deployment) and
// `DelegatedAppTokenSource` (the mothership RPC, on a laptop).
//
// Both gained the same problem at the same moment. A token used to be identified by its
// installation alone, so a `Map<number, Entry>` was the whole story. Once a container dispatch
// can ask for a token narrowed to the repos ITS run resolved, an installation-keyed entry is
// actively wrong: it would serve one run another run's scope, too wide or too narrow and
// silently either way. The fix is the same on both sides, which is why it lives here once.

/**
 * The cache key for one minted installation token: the installation, plus the SORTED repo scope
 * when the mint was narrowed with `repository_ids`.
 *
 * Sorting is what makes the key a function of the SET rather than of the order the dispatch's
 * legs happened to resolve in, so two dispatches over the same repos share an entry. An UNSCOPED
 * mint (the engine's own gate/merge calls) keys on the installation alone, so it can neither be
 * served from a narrowed entry nor poison one.
 */
export function installationTokenKey(
  installationId: number,
  repositoryIds?: readonly number[],
): string {
  if (!repositoryIds?.length) return `${installationId}`
  return `${installationId}:${[...repositoryIds].sort((a, b) => a - b).join(',')}`
}

/**
 * A scope-keyed store of minted installation tokens, holding each entry until the freshness
 * deadline its minter computed.
 *
 * Entries are IN MEMORY, per isolate/process, never persisted: persisting them would put a live
 * repo-write credential at rest, readable from any DB dump, and a miss just re-mints. The map is
 * deliberately long-lived, which is exactly why it EVICTS: keying by scope turned a map bounded
 * by the number of installations into one bounded by the number of distinct repo SETS a
 * deployment ever dispatches over, and a node that runs for days would otherwise accumulate an
 * entry per set forever. Lapsed entries are dropped on write, because a write happens only on a
 * mint (rare) while a read is on the hot path.
 */
export class InstallationTokenCache<T> {
  private readonly entries = new Map<string, { value: T; freshUntil: number }>()

  /** The cached value for `key`, or undefined when there is none or it has lapsed. */
  get(key: string, now: number): T | undefined {
    const entry = this.entries.get(key)
    if (!entry) return undefined
    if (entry.freshUntil <= now) {
      this.entries.delete(key)
      return undefined
    }
    return entry.value
  }

  /**
   * Cache `value` under `key` until `freshUntil`. The deadline is the CALLER's to compute,
   * because the two minters answer "still fresh?" differently: the App mint knows the token's
   * real GitHub expiry (minus a skew margin), while the delegation client holds a token for a
   * short window that only collapses per-call chatter.
   */
  set(key: string, value: T, freshUntil: number, now: number): void {
    for (const [existing, entry] of this.entries) {
      if (entry.freshUntil <= now) this.entries.delete(existing)
    }
    this.entries.set(key, { value, freshUntil })
  }

  /** Entry count, for tests asserting that eviction actually happens. */
  get size(): number {
    return this.entries.size
  }
}
