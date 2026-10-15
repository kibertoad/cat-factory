// Fixtures for the story-title audit. Run with `node --test scripts/`: the built-in runner, so the
// guards stay install-free.
//
// The cases that matter are the ones a reviewer would wave through. A title that is merely the
// component path reads fine in a diff and only becomes a problem at the fiftieth story, when the
// sidebar has quietly become the folder tree. The same goes for a dashed variant: `Full panel —
// files` looks like a name until there are three of them and the stem has never been said once.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { checkStoryFile, parseStoryFile } from './check-story-titles.mjs'
import { codeLines } from './lib/frontend-scan.mjs'

const parse = (source) => parseStoryFile(codeLines(source))

const check = (stem, source) => checkStoryFile({ stem, ...parse(source) })

// A stories file as the formatter writes one: the meta's properties each on their own line, which
// is what the guard's line-anchored read of `title:` assumes.
const file = (title, ...exports) =>
  [
    'const meta = {',
    `  title: '${title}',`,
    '  component: X,',
    '} satisfies Meta<typeof X>',
    'export default meta',
    ...exports.map((e) => `export const ${e}: Story = { args: {} }`),
  ].join('\n')

describe('parseStoryFile', () => {
  it('reads the title and the story exports in order', () => {
    assert.deepEqual(parse(file('Board/Components/DecisionBadge', 'Default', 'Compact')), {
      title: 'Board/Components/DecisionBadge',
      exports: ['Default', 'Compact'],
    })
  })

  it('ignores a title inside a comment, which is prose about the rule, not the rule', () => {
    const source = ["// title: 'Wrong/Thing/Here'", file('Board/Components/X', 'Default')].join(
      '\n',
    )
    assert.equal(parse(source).title, 'Board/Components/X')
  })

  it('ignores a `title` on a FIXTURE above the meta, which order alone would not protect', () => {
    const source = [
      "const auth = { id: 'svc_auth', title: 'Auth Service', type: 'service' }",
      file('Inspector/Components/ServiceConnections', 'Default'),
    ].join('\n')
    assert.equal(parse(source).title, 'Inspector/Components/ServiceConnections')
  })

  it('reports a missing title as null rather than guessing one', () => {
    assert.equal(parse('export const Default: Story = {}').title, null)
  })
})

describe('checkStoryFile', () => {
  it('passes a title in shape', () => {
    assert.deepEqual(check('DecisionBadge', file('Board/Components/DecisionBadge', 'Default')), [])
  })

  it('rejects the component path, which is the shape a sidebar decays into', () => {
    const problems = check('DecisionBadge', file('board/nodes/DecisionBadge', 'Default'))
    assert.equal(problems.length, 2)
    assert.match(problems[0], /domain "board" is not one of/)
    assert.match(problems[1], /kind "nodes" is not one of/)
  })

  it('rejects a depth other than three, in both directions', () => {
    assert.match(check('X', file('Primitives/X', 'Default'))[0], /has 2 segment\(s\)/)
    assert.match(check('X', file('A/Components/B/X', 'Default'))[0], /has 4 segment\(s\)/)
  })

  it('rejects a dashed variant: it belongs inside its stem', () => {
    const problems = check('FullPanel', file('Inspector/Components/FullPanel - files', 'Default'))
    assert.match(problems[0], /carries a dash/)
  })

  it('ties the last segment to the filename, which is what makes one-file-per-component mechanical', () => {
    const problems = check('DecisionBadge', file('Board/Components/DecisionChip', 'Default'))
    assert.deepEqual(problems, [
      'title names "DecisionChip" but the file is "DecisionBadge.stories.ts"',
    ])
  })

  it('wants Default first, so the sidebar opens on the real thing', () => {
    const problems = check('X', file('Primitives/Components/X', 'Loading', 'Default'))
    assert.deepEqual(problems, ['"Default" is exported after "Loading"; it leads the file'])
  })

  it('is content with a file that has no Default, which an exhaustive state set may not', () => {
    assert.deepEqual(check('X', file('Shell/Components/X', 'Connected', 'Reconnecting')), [])
  })

  it('rejects a lower-case export, which renders as a lower-case sidebar leaf', () => {
    assert.match(check('X', file('Primitives/Components/X', 'defaultCase'))[0], /not PascalCase/)
  })

  it('says a missing title once, rather than every downstream consequence of it', () => {
    assert.deepEqual(check('X', 'export const Default: Story = {}'), [
      'no `title:` in the meta; a story without one is filed by its path',
    ])
  })
})
