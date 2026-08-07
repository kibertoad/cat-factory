import { describe, expect, it } from 'vitest'
import {
  documentOriginSchema,
  documentSourceKindSchema,
  isConnectableSource,
  isDesignSource,
  isHostPinnedSource,
  orderSourcesByClaimConfidence,
} from './documents.js'

// The two source TRAITS the backend and the SPA both have to agree about. The `Record` behind them is
// exhaustive, so the compiler already refuses an unclassified source; what these assert is that the
// classification is CORRECT for the two decisions it drives — which fragment a run folds, and whose
// claim over a pasted URL wins.

describe('isDesignSource', () => {
  it('names exactly the sources whose documents describe a design', () => {
    // Derived from the schema rather than a hand-listed total, so adding a prose source does not fail
    // this test and adding a DESIGN one has to be stated here deliberately.
    const design = documentOriginSchema.options.filter(isDesignSource)
    expect([...design].sort()).toEqual(['figma', 'zeplin'])
  })

  it('never treats an upload as a design', () => {
    // A design source is reached through its API; an `upload` is prose the platform was handed. If
    // this flipped, every attached spec would start folding design guidance into implementer prompts.
    expect(isDesignSource('upload')).toBe(false)
  })
})

describe('isHostPinnedSource', () => {
  it('names exactly the sources whose parseRef refuses a foreign host', () => {
    // The claim-confidence ordering in `makeDocumentUrlResolver` reads this. A source listed here
    // whose parser is actually host-blind would be promoted ahead of the pinned ones and could steal
    // their URLs — the exact bug the ordering fixes, re-introduced one classification over.
    const pinned = documentSourceKindSchema.options.filter(isHostPinnedSource)
    expect([...pinned].sort()).toEqual(['figma', 'github', 'linear', 'zeplin'])
  })

  it('leaves the shape-matching parsers unpinned', () => {
    // `parseNotionRef` claims any UUID-shaped run and `parseConfluenceRef` any `/pages/<digits>`
    // segment, in ANY url — a claim about a shape, not about a reference.
    expect(isHostPinnedSource('notion')).toBe(false)
    expect(isHostPinnedSource('confluence')).toBe(false)
  })
})

describe('orderSourcesByClaimConfidence', () => {
  it('promotes every host-pinned source ahead of every blind one, keeping registration order', () => {
    // The two readers (canonicalising a URL named in prose, naming the claimant in a refusal) used to
    // spell these two passes out separately. This is the shared rule, so a refinement cannot reach one
    // and miss the other; within a pass registration order still decides, since two pinned sources
    // cannot claim one host.
    const registered = [
      { kind: 'notion' as const },
      { kind: 'figma' as const },
      { kind: 'confluence' as const },
      { kind: 'zeplin' as const },
    ]
    expect(orderSourcesByClaimConfidence(registered).map((s) => s.kind)).toEqual([
      'figma',
      'zeplin',
      'notion',
      'confluence',
    ])
  })

  it('is a no-op in shape: every source in, none added, none dropped', () => {
    const all = documentSourceKindSchema.options.map((kind) => ({ kind }))
    const ordered = orderSourcesByClaimConfidence(all)
    expect(ordered).toHaveLength(all.length)
    expect([...ordered].sort((a, b) => a.kind.localeCompare(b.kind))).toEqual(
      [...all].sort((a, b) => a.kind.localeCompare(b.kind)),
    )
  })
})

describe('the two source vocabularies', () => {
  it('classifies every connectable source and nothing else', () => {
    // Both predicates are total over the narrow union by construction; this pins the RELATION between
    // the unions that makes that safe — every origin is either connectable or the one that is not.
    const connectable = documentOriginSchema.options.filter(isConnectableSource)
    expect([...connectable].sort()).toEqual([...documentSourceKindSchema.options].sort())
    expect(documentOriginSchema.options.filter((o) => !isConnectableSource(o))).toEqual(['upload'])
  })
})
