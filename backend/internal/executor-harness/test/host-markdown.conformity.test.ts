import { hostMarkdown } from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import { inertInline, inertMarkdown } from '../src/host-markdown.js'

// `src/host-markdown.ts` is a deliberate COPY of kernel's `hostMarkdown` (the container image is
// built from `src/` plus typescript alone, so the harness can carry no runtime dependency on a
// workspace package). A copy of a SECURITY boundary is only acceptable if it cannot drift, so
// this suite pins the two to byte-identical output over a corpus of the shapes that matter.
//
// The single intended difference is the length cap: the harness caps with its own visible note
// BEFORE escaping, so its functions never truncate. Passing kernel a max far above any input
// makes its truncation a no-op and the two directly comparable.
const NO_CAP = 1_000_000

const CORPUS: Array<[name: string, input: string]> = [
  ['plain prose', 'Capped the retry loop at three attempts because the provider rate-limited us.'],
  ['issue reference', 'This closes #42 and supersedes #17.'],
  ['account mention', '@alice should decide the rounding rule; cc @acme/platform.'],
  ['gitlab mr reference', 'Follows !123 on the same branch.'],
  [
    'closing keyword before an issue url',
    'Fixes https://github.com/acme/widgets/issues/9 and resolves: https://gitlab.com/a/b/-/issues/3',
  ],
  ['triggers inside an inline code span', 'The literal `#42` and `@name` stay as written.'],
  ['heading that is not a reference', '# Title\n\n## Section\n\nBody #not-a-number.'],
  ['fenced code holding triggers', 'Before\n\n```sh\n# rebuild\ngh pr view #42 @me\n```\n\nAfter'],
  ['unbalanced fence', 'Prose\n\n```ts\nconst a = 1\n'],
  ['unbalanced tilde fence', 'Prose\n\n~~~\nstuff\n'],
  ['nested-looking fence with info string', 'a\n\n````md\n```ts\nx\n```\n````\n\nb'],
  ['crlf line endings', 'One\r\nTwo #3\r\n'],
  ['empty', ''],
  ['only a fence', '```'],
]

describe('harness host-markdown conforms to kernel hostMarkdown', () => {
  for (const [name, input] of CORPUS) {
    it(`matches prose for ${name}`, () => {
      expect(inertMarkdown(input)).toBe(hostMarkdown.prose(input, NO_CAP))
    })

    it(`matches inline for ${name}`, () => {
      expect(inertInline(input)).toBe(hostMarkdown.inline(input, NO_CAP))
    })
  }

  // The properties the copy exists for, asserted directly so a conforming-but-wrong pair
  // (both drifting together) still fails.
  it('defuses every auto-link trigger', () => {
    const out = inertMarkdown('Closes #42, cc @alice, see !7')
    expect(out).not.toMatch(/#42/)
    expect(out).not.toMatch(/@alice/)
    expect(out).not.toMatch(/!7/)
  })

  it('closes a fence the text left open', () => {
    expect(inertMarkdown('a\n\n```ts\nconst x = 1\n')).toMatch(/```$/)
  })
})
