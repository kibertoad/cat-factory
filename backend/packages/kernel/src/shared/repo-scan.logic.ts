// ---------------------------------------------------------------------------
// Shared checkout-free repo-SCAN primitives for the deterministic auto-detectors.
//
// The repo prefill heuristics (documentation-layout, service-provisioning, and
// frontend-config detection) all walk a targeted, tiny slice of a repo over a
// `RepoFiles`-shaped reader WITHOUT a clone, bounded by a hard read budget so a
// pathological repo can't fan out unboundedly. Each had grown its own near-identical copy
// of the two primitives every one of them needs — the path join/normalize helper and the
// budgeted, memoized reader wrapper. This module is the one shared home for them, so a
// fix (a normalization edge, a caching bug) lands once instead of drifting across copies.
//
// Consumers: `docs-detect.logic.ts` (agents) and the environments detectors
// (`provision-detect.logic.ts` / `frontend-detect.logic.ts`, integrations). The API here is
// the superset they collectively need — a caller uses only the subset it wants: `getFile` /
// `listDir` everywhere, `getFirstFile` (provisioning), `exists` (frontend-config), and the
// `readFault` / `exhausted` signals for the callers that raise an actionable error or a
// truncation note. `docs-detect` ignores `readFault` (it degrades to defaults instead).
// ---------------------------------------------------------------------------

/** A directory-listing entry as returned by the checkout-free contents API. */
export interface RepoScanEntry {
  name: string
  type: string
  path: string
}

/**
 * The narrow checkout-free repo reader the {@link BudgetedRepoScanner} wraps — a kernel
 * `RepoFiles` satisfies it structurally, and a test supplies an in-memory fake. A MISSING
 * path yields `null` / `[]`, so the heuristics degrade gracefully on partial repos. A
 * genuine read fault (auth/permission revoked, rate limit, transport error) may THROW — the
 * real GitHub/GitLab reader throws on any non-404 status; the scanner tolerates it (records
 * the first one, keeps scanning best-effort). `listDirectory` is optional so a reader that
 * only ever reads files (e.g. the frontend-config detector) satisfies it too.
 */
export interface CheckoutFreeRepoReader {
  getFile(path: string, gitRef?: string): Promise<{ content: string } | null>
  listDirectory?(path: string, gitRef?: string): Promise<RepoScanEntry[]>
}

/** Join + normalize repo-relative path segments (drops empties, collapses `.`, resolves `..`). */
export function joinRepoPath(...parts: (string | undefined)[]): string {
  const segs: string[] = []
  for (const part of parts) {
    if (!part) continue
    for (const seg of part.split('/')) {
      if (!seg || seg === '.') continue
      if (seg === '..') segs.pop()
      else segs.push(seg)
    }
  }
  return segs.join('/')
}

/**
 * Stateful checkout-free repo reader wrapper with a hard read budget + per-path memoization,
 * shared by the repo auto-detectors (docs-layout / provisioning / frontend-config prefills).
 * The budget stops detection fanning out without bound; memoization keeps each unique path to a
 * single real round-trip (the passes list several dirs in common), so a cache hit is free (no
 * budget spend) and deterministic. Every method is TOTAL — a read fault is swallowed (recorded
 * as an empty result) so a caller that ignores {@link readFault} degrades to defaults rather
 * than throwing; a caller that wants an actionable error consults {@link readFault} after the
 * scan when it detected nothing.
 */
export class BudgetedRepoScanner {
  private reads = 0
  private truncated = false
  private firstFault: string | undefined
  private readonly fileCache = new Map<string, string | null>()
  private readonly dirCache = new Map<string, RepoScanEntry[]>()

  constructor(
    private readonly reader: CheckoutFreeRepoReader,
    private readonly budget: number,
    private readonly gitRef?: string,
  ) {}

  /**
   * True only once a read was ACTUALLY skipped because the budget was hit — so a complete scan
   * that happens to spend exactly the budget doesn't spuriously report itself truncated.
   */
  get exhausted(): boolean {
    return this.truncated
  }

  /**
   * The message of the FIRST genuine read fault the reader threw (auth/permission revoked, rate
   * limit, transport error), else `undefined`. A miss (absent path) is NOT a fault.
   */
  get readFault(): string | undefined {
    return this.firstFault
  }

  private recordFault(err: unknown): void {
    if (this.firstFault === undefined) {
      this.firstFault = err instanceof Error ? err.message : String(err)
    }
  }

  async getFile(path: string): Promise<string | null> {
    const cached = this.fileCache.get(path)
    if (cached !== undefined) return cached
    if (this.reads >= this.budget) {
      this.truncated = true
      return null
    }
    this.reads++
    let content: string | null = null
    try {
      content = (await this.reader.getFile(path, this.gitRef))?.content ?? null
    } catch (err) {
      // A genuine read fault (non-404 — the reader turns 404 into null itself). Keep scanning
      // best-effort (a transient fault mustn't lose a good result) but record it so an all-miss
      // outcome can be reported as "couldn't read" rather than "nothing found".
      this.recordFault(err)
    }
    this.fileCache.set(path, content)
    return content
  }

  /** True when a file exists (a cheap presence probe that still spends one read). */
  async exists(path: string): Promise<boolean> {
    return (await this.getFile(path)) !== null
  }

  /** Read the first present file among `names` in `dir`; returns its content + matched name. */
  async getFirstFile(
    dir: string,
    names: string[],
  ): Promise<{ name: string; content: string } | null> {
    for (const name of names) {
      const content = await this.getFile(joinRepoPath(dir, name))
      if (content !== null) return { name, content }
    }
    return null
  }

  async listDir(path: string): Promise<RepoScanEntry[]> {
    const cached = this.dirCache.get(path)
    if (cached !== undefined) return cached
    if (this.reads >= this.budget) {
      this.truncated = true
      return []
    }
    this.reads++
    let entries: RepoScanEntry[] = []
    try {
      entries = (await this.reader.listDirectory?.(path, this.gitRef)) ?? []
    } catch (err) {
      this.recordFault(err)
      entries = []
    }
    this.dirCache.set(path, entries)
    return entries
  }
}
