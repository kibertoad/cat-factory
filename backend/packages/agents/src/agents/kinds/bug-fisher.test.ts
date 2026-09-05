import { describe, expect, it } from 'vitest'
import {
  BUG_FISHER_KIND,
  BUG_FISHER_SYSTEM_PROMPT,
  BUG_FISHING_TERRITORY_CONTEXT_FILE,
  BUG_FISHING_TERRITORY_CONTEXT_PATH,
  renderBugFishingPhaseBrief,
  renderBugFishingTerritoryContext,
} from './bug-fisher.js'
import { defaultAgentKindRegistry } from './registry.js'
import { standardsAsContextFilesPreOp } from './pr-review-context.js'

const phase = {
  id: 'concurrency',
  title: 'Concurrency, ordering & idempotency',
  goal: 'Find what breaks when two callers race.',
  focus: 'Read the shared state and the write paths.',
}

describe('bug-fisher kind declarations', () => {
  it('delivers its standards as FILES, and registers the op that writes them', () => {
    // Two halves of one decision. `standardsDelivery` only stops the engine folding the standards
    // into the system prompt; without the op that writes them, a `code-aware` kind declaring
    // `context-files` stops delivering its standards at all, and the loss is invisible.
    const registry = defaultAgentKindRegistry()
    expect(registry.standardsDelivery(BUG_FISHER_KIND)).toBe('context-files')
    expect(registry.preOps(BUG_FISHER_KIND)).toContain(standardsAsContextFilesPreOp)
  })

  it('TELLS the pass its standards are files, which is the third half of that decision', () => {
    // The op writes them and the flag suppresses the fold, so without a prompt that names the
    // files the standards land in a directory the agent has no reason to open: byte-for-byte the
    // silent loss the two halves above exist to prevent.
    expect(BUG_FISHER_SYSTEM_PROMPT).toContain('.cat-context/standards.md')
    expect(BUG_FISHER_SYSTEM_PROMPT).toContain('.cat-context/standard-<id>.md')
  })
})

describe('renderBugFishingPhaseBrief', () => {
  it('names the territory a pass owns and the paths it may report against', () => {
    const brief = renderBugFishingPhaseBrief({
      phase,
      position: { index: 3, total: 8 },
      territory: { label: 'billing', roots: ['packages/billing'] },
    })
    expect(brief).toContain('Territory: billing')
    expect(brief).toContain('packages/billing')
  })

  it('names no territory for a whole-codebase pass, which is the pass-through', () => {
    const brief = renderBugFishingPhaseBrief({ phase, position: { index: 1, total: 8 } })
    expect(brief).not.toContain('Territory:')
  })

  it("says the prior findings are the TERRITORY's when the pass has one", () => {
    // Across thirty passes the whole catch is hundreds of lines nobody in territory five needs,
    // so the brief has to say which list it is showing or the pass reads it as the whole one.
    const scoped = renderBugFishingPhaseBrief({
      phase,
      position: { index: 2, total: 4 },
      territory: { label: 'billing', roots: ['billing'] },
      priorFindingTitles: ['A stale cache'],
    })
    expect(scoped).toContain('IN THIS TERRITORY')
  })
})

describe('renderBugFishingTerritoryContext', () => {
  const territory = { label: 'billing', roots: ['packages/billing'], approxTokens: 120_000 }

  it('hands over the directory shape and the file list while it stays small', () => {
    const rendered = renderBugFishingTerritoryContext({
      territory,
      files: ['packages/billing/invoice.ts', 'packages/billing/tax/vat.ts'],
      neighbours: ['sessions'],
    })
    expect(rendered).toContain('# Territory: billing')
    expect(rendered).toContain('`packages/billing` (1 file)')
    expect(rendered).toContain('`packages/billing/tax` (1 file)')
    expect(rendered).toContain('packages/billing/invoice.ts')
    expect(rendered).toContain('sessions')
  })

  it('withholds the file list above the cap, and SAYS it did', () => {
    // A map that costs a tenth of the budget it exists to save is not a map. The directory counts
    // stay complete, so what is withheld is a list the pass can rebuild on demand, not a fact.
    const files = Array.from({ length: 40 }, (_, i) => `packages/billing/f${i}.ts`)
    const rendered = renderBugFishingTerritoryContext({
      territory,
      files,
      neighbours: [],
      maxListedFiles: 10,
    })
    expect(rendered).toContain('40 paths')
    expect(rendered).not.toContain('- `packages/billing/f0.ts`')
    expect(rendered).toContain('`packages/billing` (40 files)')
  })

  it('is injected under a NAME and read at a PATH, and the prompt names the path', () => {
    // `InjectedContextFile.path` is the name INSIDE the run's context directory: the harness
    // strips any directory part, so a path spelled with the directory in it landed correctly and
    // was recorded as `.cat-context/.cat-context/territory.md` everywhere the run is inspected.
    expect(BUG_FISHING_TERRITORY_CONTEXT_FILE).toBe('territory.md')
    expect(BUG_FISHING_TERRITORY_CONTEXT_PATH).toBe('.cat-context/territory.md')
    expect(BUG_FISHER_SYSTEM_PROMPT).toContain(BUG_FISHING_TERRITORY_CONTEXT_PATH)
  })
})
