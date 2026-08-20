import { getFragment } from '@cat-factory/prompt-fragments'
import { describe, expect, it } from 'vitest'
import { composeBlockSystemPrompt, standardsDeliveredAsFiles } from './fragments.js'
import {
  FRAGMENT_ADHERENCE_GUIDANCE,
  FRAGMENT_ADHERENCE_GUIDANCE_CONTEXT_FILES,
  STANDARDS_SECTION_OPENER,
} from '../prompts/shared.js'

// Best-practice standards are folded into the system prompt as SEPARATE, delimited, title-labelled
// `<best-practice-standard>` blocks (not one `\n\n`-joined blob), so an agent can tell them apart and
// cite one by title — what the code/PR reviewers' adherence report relies on.

describe('composeBlockSystemPrompt', () => {
  it('returns the base prompt unchanged when no fragments are resolved', () => {
    expect(composeBlockSystemPrompt('BASE', { resolvedFragments: [] }, 'prompt')).toBe('BASE')
    expect(composeBlockSystemPrompt('BASE', {}, 'prompt')).toBe('BASE')
  })

  it('carries the hard-requirement imperative ONLY where the blocks it points at exist', () => {
    // The imperative used to be the closing line of every track prompt, while the fold returns the
    // base UNCHANGED with nothing to fold — so a block that resolved no standards ended by naming a
    // section that was never injected, and the graders reported agents both reviewing against and
    // reporting the absence of it. The section owns the line now, so the pointer and its target are
    // the same decision.
    const withStandards = composeBlockSystemPrompt(
      'BASE',
      { resolvedFragments: [{ id: 'be-errors', body: 'Wrap errors with context.' }] },
      'prompt',
    )
    expect(withStandards).toContain(STANDARDS_SECTION_OPENER)
    // It precedes the blocks it introduces, so "below" is true of it.
    expect(withStandards.indexOf(STANDARDS_SECTION_OPENER)).toBeLessThan(
      withStandards.indexOf('<best-practice-standard'),
    )

    for (const composed of [
      composeBlockSystemPrompt('BASE', { resolvedFragments: [] }, 'prompt'),
      composeBlockSystemPrompt('BASE', {}, 'prompt'),
      // A `context-files` kind's standards are delivered as files whose own index states they are
      // what the review is judged against; a `none` kind applies no standards at all.
      composeBlockSystemPrompt(
        'BASE',
        { resolvedFragments: [{ id: 'x', body: 'y' }] },
        'context-files',
        true,
      ),
      composeBlockSystemPrompt('BASE', { resolvedFragments: [{ id: 'x', body: 'y' }] }, 'none'),
    ]) {
      expect(composed).not.toContain(STANDARDS_SECTION_OPENER)
    }
  })

  it('never asserts, in either constant, that standards were folded when none were', () => {
    // Two strings pointed at the same section: the opener's "appended below" and the adherence
    // guidance's "folded into this prompt above". The fold writes neither the section nor an empty
    // array when a block resolved no standards, so both dangled, and the graders quoted both.
    //
    // Asserted as the STRUCTURAL property rather than as the absence of those two phrasings: a
    // reworded "attached beneath" would pass a negative-phrase check while claiming presence just
    // as falsely, so what is pinned is that the imperative appears exactly when a block does.
    for (const block of [
      { resolvedFragments: [{ id: 'x', body: 'y' }] },
      { resolvedFragments: [] },
    ]) {
      const composed = composeBlockSystemPrompt('BASE', block, 'prompt')
      expect(composed.includes(STANDARDS_SECTION_OPENER)).toBe(
        composed.includes('<best-practice-standard'),
      )
    }
    // The adherence guidance is a JSON output contract, not a standards header, so it cannot move
    // into the fold and has to be true wherever it lands instead. It therefore claims no POSITION:
    // the fold appends the blocks BELOW the base prompt that carries it, so a reviewer applying
    // "if no such block appears above" to the text above it would find none and report an absence
    // on a run where the standards WERE folded in.
    expect(FRAGMENT_ADHERENCE_GUIDANCE).not.toMatch(/\babove\b/)
    expect(FRAGMENT_ADHERENCE_GUIDANCE).toContain('empty array')
    const review = composeBlockSystemPrompt(
      `ROLE. ${FRAGMENT_ADHERENCE_GUIDANCE}`,
      { resolvedFragments: [{ id: 'x', body: 'y' }] },
      'prompt',
    )
    expect(review.indexOf(FRAGMENT_ADHERENCE_GUIDANCE)).toBeLessThan(
      review.indexOf('<best-practice-standard'),
    )
  })

  it('wraps each standard in its own delimited, id + title labelled block', () => {
    const out = composeBlockSystemPrompt(
      'BASE',
      {
        resolvedFragments: [
          { id: 'be-errors', title: 'Backend error handling', body: 'Wrap errors with context.' },
          { id: 'api-docs', title: 'Concise API docs', body: 'Document every export.' },
        ],
      },
      'prompt',
    )
    expect(out).toContain('BASE')
    expect(out).toContain('<best-practice-standard id="be-errors" title="Backend error handling">')
    expect(out).toContain('Wrap errors with context.')
    expect(out).toContain('</best-practice-standard>')
    expect(out).toContain('<best-practice-standard id="api-docs" title="Concise API docs">')
    // Two separate blocks, not a single joined blob.
    expect(out.match(/<best-practice-standard /g)).toHaveLength(2)
    expect(out.match(/<\/best-practice-standard>/g)).toHaveLength(2)
  })

  it('falls back to the id as the label when a fragment has no title', () => {
    const out = composeBlockSystemPrompt(
      'BASE',
      { resolvedFragments: [{ id: 'legacy-frag', body: 'Do the thing.' }] },
      'prompt',
    )
    expect(out).toContain('<best-practice-standard id="legacy-frag" title="legacy-frag">')
  })

  it('neutralises characters that would break the delimiter tag', () => {
    const out = composeBlockSystemPrompt(
      'BASE',
      { resolvedFragments: [{ id: 'x', title: 'He said "quote" <b> &\nnext line', body: 'body' }] },
      'prompt',
    )
    // The title's own quotes/angle-brackets are neutralised to apostrophes and the newline is
    // collapsed, so the whole standard opens on a single well-formed tag line.
    const tag = out.split('\n').find((l) => l.startsWith('<best-practice-standard'))!
    expect(tag).toBe(`<best-practice-standard id="x" title="He said 'quote' 'b' & next line">`)
  })

  // A `context-files` kind (e.g. pr-reviewer) delivers its standards as `.cat-context/` files, so
  // the fold must be SUPPRESSED — but only once those files were actually delivered, else the
  // standards would be lost through both channels.
  describe("delivery: 'context-files'", () => {
    const block = {
      resolvedFragments: [{ id: 'be-errors', title: 'Backend errors', body: 'Wrap errors.' }],
    }

    it('suppresses the fold when the standards were delivered as files', () => {
      expect(composeBlockSystemPrompt('BASE', block, 'context-files', true)).toBe('BASE')
    })

    it('falls back to folding when the standards were NOT delivered (preOp skipped)', () => {
      // The run-repo resolver was unwired, so the standards preOp never ran and no files landed.
      // Folding into the prompt is the correct recovery — never lose the standards entirely.
      const out = composeBlockSystemPrompt('BASE', block, 'context-files', false)
      expect(out).toContain('<best-practice-standard id="be-errors" title="Backend errors">')
      expect(out).toContain('Wrap errors.')
    })

    it('does not tell the reviewer the standards are absent on the run that folded them in', () => {
      // The fallback above is why the `context-files` guidance may not say the standards are NOT in
      // this prompt: the same composition that recovers them by folding would then carry both the
      // section AND an instruction to report that none were available, which is the dangling
      // pointer this whole change is about, mirror-imaged.
      const folded = composeBlockSystemPrompt(
        `ROLE. ${FRAGMENT_ADHERENCE_GUIDANCE_CONTEXT_FILES}`,
        block,
        'context-files',
        false,
      )
      expect(folded).toContain('<best-practice-standard id="be-errors" title="Backend errors">')
      expect(FRAGMENT_ADHERENCE_GUIDANCE_CONTEXT_FILES).not.toMatch(/are NOT in this prompt/)
      // It names both channels and reports an absence only when NEITHER carried anything.
      expect(FRAGMENT_ADHERENCE_GUIDANCE_CONTEXT_FILES).toContain('.cat-context/standards.md')
      expect(FRAGMENT_ADHERENCE_GUIDANCE_CONTEXT_FILES).toContain('<best-practice-standard>')
      expect(FRAGMENT_ADHERENCE_GUIDANCE_CONTEXT_FILES).toMatch(/If NEITHER channel carries any/)
    })
  })
})

// Implementer kinds (coder/fixer/…) fold each standard's CONDENSED `brief` instead of its full
// `body`, to shrink the system prompt that is re-sent on every turn of their long agentic loop.
// The brief travels WITH the resolved fragment (never re-looked-up by id), so it is always the
// condensed form of the body that actually won the tier merge.
describe("foldStandards verbosity: 'brief'", () => {
  it("folds a fragment's condensed brief for an implementer kind, not its full body", () => {
    const out = composeBlockSystemPrompt(
      'BASE',
      {
        resolvedFragments: [
          {
            id: 'node.performance',
            title: 'Node performance',
            body: 'FULL_BODY_MARKER',
            brief: 'BRIEF_MARKER',
          },
        ],
      },
      'prompt',
      false,
      'brief',
    )
    expect(out).toContain('BRIEF_MARKER')
    expect(out).not.toContain('FULL_BODY_MARKER')
  })

  it('folds the built-in brief when the ids resolve against the static pool', () => {
    const brief = getFragment('node.performance')?.brief
    expect(brief).toBeTruthy() // the built-in defines one
    const out = composeBlockSystemPrompt(
      'BASE',
      { fragmentIds: ['node.performance'] },
      'prompt',
      false,
      'brief',
    )
    expect(out).toContain(brief as string)
  })

  it('falls back to the full body when the resolved fragment carries no brief', () => {
    const out = composeBlockSystemPrompt(
      'BASE',
      { resolvedFragments: [{ id: 'not-in-pool', title: 'X', body: 'FULL_ONLY' }] },
      'prompt',
      false,
      'brief',
    )
    expect(out).toContain('FULL_ONLY')
  })

  // The tier merge lets a workspace/account row OVERRIDE a built-in id. Re-resolving the brief
  // from the static pool would then fold the BUILT-IN's condensed text over the tenant's body —
  // silently ignoring their standard for exactly the kinds `brief` targets. The resolver supplies
  // no brief for a managed row, so the override's own full body must be folded.
  it("folds a tenant override's own body, never the built-in brief for the same id", () => {
    const out = composeBlockSystemPrompt(
      'BASE',
      {
        resolvedFragments: [
          { id: 'node.performance', title: 'Node performance (house rules)', body: 'TENANT_BODY' },
        ],
      },
      'prompt',
      false,
      'brief',
    )
    expect(out).toContain('TENANT_BODY')
    expect(out).not.toContain(getFragment('node.performance')?.brief as string)
  })

  it("uses the full body under the default 'full' verbosity even when a brief exists", () => {
    const out = composeBlockSystemPrompt(
      'BASE',
      {
        resolvedFragments: [
          {
            id: 'node.performance',
            title: 'Node performance',
            body: 'FULL_BODY_MARKER',
            brief: 'BRIEF_MARKER',
          },
        ],
      },
      'prompt',
    )
    expect(out).toContain('FULL_BODY_MARKER')
    expect(out).not.toContain('BRIEF_MARKER')
  })
})

describe('standardsDeliveredAsFiles', () => {
  it('is true when the standards index or a per-standard file was injected', () => {
    expect(standardsDeliveredAsFiles([{ path: 'standards.md' }])).toBe(true)
    expect(standardsDeliveredAsFiles([{ path: 'standard-idiomatic-csharp.md' }])).toBe(true)
    expect(standardsDeliveredAsFiles([{ path: 'pr-diff.md' }, { path: 'standard-x.md' }])).toBe(
      true,
    )
  })

  it('is false when no standards file is present (or none were injected at all)', () => {
    expect(standardsDeliveredAsFiles([{ path: 'pr-diff.md' }])).toBe(false)
    expect(standardsDeliveredAsFiles([])).toBe(false)
    expect(standardsDeliveredAsFiles(undefined)).toBe(false)
  })
})
