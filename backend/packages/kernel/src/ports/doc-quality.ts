// The data source the `doc-quality` gate probes: a deterministic structural check of a
// drafted document on its PR head. Modelled exactly like `CiStatusProvider` — a
// runtime-neutral port whose impl (in `@cat-factory/server`) resolves the block's document
// kind + target path, reads the file (and its linked files) checkout-free via the
// `RepoFiles` port, resolves the required sections from the WS1 template
// (`docTemplateFor`, the single source of truth), and classifies via
// `analyzeDocStructure` (kernel `domain/doc-quality-logic.ts`). The gate stays thin: it
// calls `check` and maps the verdict to pass/fail (see `@cat-factory/gates`).

/** The verdict the {@link DocQualityProvider} returns for a block's drafted document. */
export interface DocQualityReport {
  /** Whether every deterministic structural check passed (or there was nothing to gate). */
  ok: boolean
  /** The PR head commit the checks ran against, or null when there is no open PR / document. */
  headSha: string | null
  /** The document path that was checked (for the pass/fail step output). */
  path?: string
  /**
   * The structural findings on a failed check — one human-readable line each (missing
   * required section, leftover placeholder, heading-hierarchy problem, unresolved in-repo
   * link). Empty when {@link ok} is true. Handed to the `doc-fixer` helper as its brief.
   */
  findings: string[]
}

/** The data source the `doc-quality` gate probes (wired per facade over a `RepoFiles`). */
export interface DocQualityProvider {
  check(workspaceId: string, blockId: string): Promise<DocQualityReport>
}
