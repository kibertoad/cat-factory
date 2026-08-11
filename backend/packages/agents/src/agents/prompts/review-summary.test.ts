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
    const own = registryWithOwnCompanion()
    expect(systemPromptFor('house-style-companion', own)).toContain(REVIEW_SUMMARY_LAYOUT)
  })

  it('survives a per-workspace prompt override, which replaces the whole track prompt', () => {
    // The layout is a fact about how the platform READS and RENDERS the verdict, so it belongs to
    // the same set as the final-answer rule: an override edited for an unrelated reason would
    // otherwise send every later verdict back to one paragraph (and drop the JSON-escaping rule
    // with it), with nothing in the editor saying why. Asserted for a deployment's own companion
    // too, since that is the pairing whose prompt nobody here wrote.
    const edited = 'You are our house code reviewer. Be blunt and rate 0..1.'
    for (const companion of COMPANIONS) {
      expect(systemPromptFor(companion.kind, registry, edited)).toContain(REVIEW_SUMMARY_LAYOUT)
    }
    expect(systemPromptFor('house-style-companion', registryWithOwnCompanion(), edited)).toContain(
      REVIEW_SUMMARY_LAYOUT,
    )
  })

  it('stays OFF a judge, which reports its points as structured findings', () => {
    // `JudgeResultView` renders the `findings` array as its own list directly below the summary, so
    // the layout would have every point written twice in two orderings that can disagree. Same
    // reason the `pr-reviewer` and the tester are excluded: they need the render half only.
    expect(JUDGE_SYSTEM_PROMPT).not.toContain(REVIEW_SUMMARY_LAYOUT)
    expect(JUDGE_SYSTEM_PROMPT).toContain('do NOT restate the findings there')
  })

  it('names the shape a reader can skim: a verdict line, then grouped bullets', () => {
    // The value is the SKELETON, not the wording: a layout instruction that named no labels
    // would satisfy a `toContain` on the constant while leaving each reviewer to invent one.
    expect(REVIEW_SUMMARY_LAYOUT).toContain('**Must fix**')
    expect(REVIEW_SUMMARY_LAYOUT).toContain('**Should fix**')
    expect(REVIEW_SUMMARY_LAYOUT).toContain('**Minor**')
    // The summary rides a JSON string, so a raw line break in the layout it asks for is what
    // would otherwise cost the verdict a repair retry (kernel's `extractJson` repairs it), and a
    // fenced block would put a ``` pair ahead of the object `extractJson` is looking for.
    expect(REVIEW_SUMMARY_LAYOUT).toContain('\\n escapes')
    expect(REVIEW_SUMMARY_LAYOUT).toContain('never open a fenced code block')
  })
})

/** A registry carrying a deployment's OWN companion pairing, the seam a real deployment uses. */
function registryWithOwnCompanion() {
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
  return own
}
