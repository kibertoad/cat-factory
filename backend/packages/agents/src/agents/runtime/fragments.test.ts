import { getFragment } from '@cat-factory/prompt-fragments'
import { describe, expect, it } from 'vitest'
import { composeBlockSystemPrompt, standardsDeliveredAsFiles } from './fragments.js'

// Best-practice standards are folded into the system prompt as SEPARATE, delimited, title-labelled
// `<best-practice-standard>` blocks (not one `\n\n`-joined blob), so an agent can tell them apart and
// cite one by title — what the code/PR reviewers' adherence report relies on.

describe('composeBlockSystemPrompt', () => {
  it('returns the base prompt unchanged when no fragments are resolved', () => {
    expect(composeBlockSystemPrompt('BASE', { resolvedFragments: [] }, 'prompt')).toBe('BASE')
    expect(composeBlockSystemPrompt('BASE', {}, 'prompt')).toBe('BASE')
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
  })
})

// Implementer kinds (coder/fixer/…) fold each standard's CONDENSED `brief` instead of its full
// `body`, to shrink the system prompt that is re-sent on every turn of their long agentic loop.
// The brief is looked up from the pool by id, so it applies to both the id-resolved and the
// engine-resolved (`resolvedFragments`) sources.
describe("foldStandards verbosity: 'brief'", () => {
  it("folds a fragment's condensed brief for an implementer kind, not its full body", () => {
    const brief = getFragment('node.performance')?.brief
    expect(brief).toBeTruthy() // the built-in defines one
    const out = composeBlockSystemPrompt(
      'BASE',
      {
        resolvedFragments: [
          { id: 'node.performance', title: 'Node performance', body: 'FULL_BODY_MARKER' },
        ],
      },
      'prompt',
      false,
      'brief',
    )
    expect(out).toContain(brief as string)
    expect(out).not.toContain('FULL_BODY_MARKER')
  })

  it('falls back to the full body when the fragment defines no brief', () => {
    const out = composeBlockSystemPrompt(
      'BASE',
      { resolvedFragments: [{ id: 'not-in-pool', title: 'X', body: 'FULL_ONLY' }] },
      'prompt',
      false,
      'brief',
    )
    expect(out).toContain('FULL_ONLY')
  })

  it("uses the full body under the default 'full' verbosity even when a brief exists", () => {
    const out = composeBlockSystemPrompt(
      'BASE',
      {
        resolvedFragments: [
          { id: 'node.performance', title: 'Node performance', body: 'FULL_BODY_MARKER' },
        ],
      },
      'prompt',
    )
    expect(out).toContain('FULL_BODY_MARKER')
    expect(out).not.toContain(getFragment('node.performance')?.brief as string)
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
