import { describe, expect, it } from 'vitest'
import { DEFAULT_COMPANION_THRESHOLD, reviewCommentSeveritySchema } from '@cat-factory/contracts'
import { systemPromptFor } from '../catalog.js'
import { COMPANIONS } from '../kinds/companions.js'
import { defaultAgentKindRegistry } from '../kinds/registry.js'
import { JUDGE_SYSTEM_PROMPT } from './judge.js'
import { REVIEW_FINDINGS_LAYOUT } from './shared.js'

// A companion's findings are the only place its urgency judgement can reach the engine: the rating
// is one number over the whole deliverable, and `disposeCompanionVerdict` holds the step on a
// `blocker` comment. So a companion that was never told to grade its points reports a must-fix and
// a nit as the same thing, and the run advances on the average. Pinned as a RELATION over the
// companion catalog rather than a list of the built-ins, so a companion added later (built-in or
// deployment-registered) is covered by the same assertion instead of quietly opting out of it.

describe('the graded review-findings contract', () => {
  const registry = defaultAgentKindRegistry()

  it('reaches every built-in companion through the prompt actually sent', () => {
    expect(COMPANIONS.length).toBeGreaterThan(0)
    for (const companion of COMPANIONS) {
      expect(systemPromptFor(companion.kind, registry)).toContain(REVIEW_FINDINGS_LAYOUT)
    }
  })

  it('reaches a DEPLOYMENT-registered companion on the same terms', () => {
    const own = registryWithOwnCompanion()
    expect(systemPromptFor('house-style-companion', own)).toContain(REVIEW_FINDINGS_LAYOUT)
  })

  it('survives a per-workspace prompt override, which replaces the whole track prompt', () => {
    // The contract is a fact about how the platform READS and ACTS ON the verdict, so it belongs to
    // the same set as the final-answer rule: an override edited for an unrelated reason would
    // otherwise send every later verdict back as ungraded findings — nothing able to hold the run —
    // with nothing in the editor saying why. Asserted for a deployment's own companion too, since
    // that is the pairing whose prompt nobody here wrote.
    const edited = 'You are our house code reviewer. Be blunt and rate 0..1.'
    for (const companion of COMPANIONS) {
      expect(systemPromptFor(companion.kind, registry, edited)).toContain(REVIEW_FINDINGS_LAYOUT)
    }
    expect(systemPromptFor('house-style-companion', registryWithOwnCompanion(), edited)).toContain(
      REVIEW_FINDINGS_LAYOUT,
    )
  })

  it('stays OFF a judge, which already reports graded findings of its own', () => {
    // `JudgeResultView` renders the judge's own `findings` array with its own severity vocabulary,
    // so this would be a second grading scheme over the same points. Same reason the `pr-reviewer`
    // and the tester are excluded: they report structured findings already.
    expect(JUDGE_SYSTEM_PROMPT).not.toContain(REVIEW_FINDINGS_LAYOUT)
    expect(JUDGE_SYSTEM_PROMPT).toContain('do NOT restate the findings there')
  })

  it('names every severity the engine can act on, and what a blocker costs', () => {
    // The value is the VOCABULARY plus its consequence, not the wording: an instruction that asked
    // for "a severity" without naming the members would satisfy a `toContain` on the constant while
    // leaving each reviewer to invent a scale the schema then reads as its `major` fallback.
    for (const severity of reviewCommentSeveritySchema.options) {
      expect(REVIEW_FINDINGS_LAYOUT).toContain(`"${severity}"`)
    }
    expect(REVIEW_FINDINGS_LAYOUT).toContain('does NOT advance')
    // With the points structured, the summary must not carry them a second time: both are
    // rendered, so a restated list is one review written twice in two orderings that can disagree.
    expect(REVIEW_FINDINGS_LAYOUT).toContain('NOT A SECOND COPY OF THE LIST')
    // The summary rides a JSON string, so a raw line break in it is what would otherwise cost the
    // verdict a repair retry (kernel's `extractJson` repairs it), and a fenced block would put a
    // ``` pair ahead of the object `extractJson` is looking for.
    expect(REVIEW_FINDINGS_LAYOUT).toContain('\\n escape')
    expect(REVIEW_FINDINGS_LAYOUT).toContain('Never open a fenced code block')
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
