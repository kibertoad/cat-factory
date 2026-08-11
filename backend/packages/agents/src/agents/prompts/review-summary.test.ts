import { describe, expect, it } from 'vitest'
import { DEFAULT_COMPANION_THRESHOLD } from '@cat-factory/contracts'
import { systemPromptFor } from '../catalog.js'
import { COMPANIONS } from '../kinds/companions.js'
import { defaultAgentKindRegistry } from '../kinds/registry.js'
import { JUDGE_SYSTEM_PROMPT } from './judge.js'
import { REVIEW_SUMMARY_LAYOUT } from './shared.js'

// A reviewer whose `summary` IS the review a human reads has to be told how to lay that
// summary out, or the entire verdict arrives as one unskimmable paragraph that numbers its
// findings inline. Pinned as a RELATION over the companion catalog rather than a list of the
// four built-ins, so a companion added later (built-in or deployment-registered) is covered by
// the same assertion instead of quietly opting out of it.

describe('the human-facing review summary layout', () => {
  const registry = defaultAgentKindRegistry()

  it('reaches every built-in companion through the prompt actually sent', () => {
    expect(COMPANIONS.length).toBeGreaterThan(0)
    for (const companion of COMPANIONS) {
      expect(systemPromptFor(companion.kind, registry)).toContain(REVIEW_SUMMARY_LAYOUT)
    }
  })

  it('reaches a DEPLOYMENT-registered companion on the same terms', () => {
    const own = defaultAgentKindRegistry()
    own.register({
      kind: 'house-style-companion',
      systemPrompt: 'ignored: the companion track owns the prompt for a registered pairing',
      agent: { surface: 'inline' },
    })
    own.registerCompanion({
      kind: 'house-style-companion',
      targets: ['coder'],
      defaultThreshold: DEFAULT_COMPANION_THRESHOLD,
      reviews: 'house style of the change',
    })
    expect(systemPromptFor('house-style-companion', own)).toContain(REVIEW_SUMMARY_LAYOUT)
  })

  it('reaches every judge assessment, whatever rubric it scores', () => {
    // One prompt runs every registered rubric, so this single assertion covers them all.
    expect(JUDGE_SYSTEM_PROMPT).toContain(REVIEW_SUMMARY_LAYOUT)
  })

  it('names the shape a reader can skim: a verdict line, then grouped bullets', () => {
    // The value is the SKELETON, not the wording: a layout instruction that named no labels
    // would satisfy a `toContain` on the constant while leaving each reviewer to invent one.
    expect(REVIEW_SUMMARY_LAYOUT).toContain('**Must fix**')
    expect(REVIEW_SUMMARY_LAYOUT).toContain('**Should fix**')
    expect(REVIEW_SUMMARY_LAYOUT).toContain('**Minor**')
    // The summary rides a JSON string, so a raw line break in the layout it asks for is what
    // would otherwise cost the verdict a repair retry (kernel's `extractJson` repairs it).
    expect(REVIEW_SUMMARY_LAYOUT).toContain('\\n escapes')
  })
})
