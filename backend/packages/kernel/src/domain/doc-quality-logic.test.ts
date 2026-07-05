import { describe, expect, it } from 'vitest'
import {
  analyzeDocStructure,
  hasDocStructureIssues,
  resolveDocLinkPath,
} from './doc-quality-logic.js'

describe('analyzeDocStructure', () => {
  it('reports no issues for a well-formed document that covers every required section', () => {
    const content = [
      '# Login PRD',
      '',
      '## Overview',
      'What we build.',
      '## Problem and Goals',
      'The problem.',
      '## Success Metrics',
      'The metrics.',
    ].join('\n')
    const analysis = analyzeDocStructure({
      content,
      // "Problem & Goals" required, matched by the "Problem and Goals" heading (word-subset).
      requiredSections: ['Overview', 'Problem & Goals', 'Success Metrics'],
    })
    expect(analysis.missingSections).toEqual([])
    expect(analysis.placeholders).toEqual([])
    expect(analysis.headingIssues).toEqual([])
    expect(hasDocStructureIssues(analysis)).toBe(false)
  })

  it('flags a required section with no matching heading', () => {
    const analysis = analyzeDocStructure({
      content: '# Doc\n\n## Overview\ntext',
      requiredSections: ['Overview', 'Success Metrics'],
    })
    expect(analysis.missingSections).toEqual(['Success Metrics'])
    expect(hasDocStructureIssues(analysis)).toBe(true)
  })

  it('detects leftover placeholder markers but ignores them inside fenced code', () => {
    const analysis = analyzeDocStructure({
      content: [
        '# <Document title>',
        '',
        '## Overview',
        'TODO: write this.',
        '',
        '```',
        '// TODO in a code sample is fine',
        '```',
      ].join('\n'),
      requiredSections: ['Overview'],
    })
    expect(analysis.placeholders).toContain('TODO')
    expect(analysis.placeholders).toContain('<…> placeholder')
    // The section list still matches (the H1 placeholder title isn't a required section).
    expect(analysis.missingSections).toEqual([])
  })

  it('does not flag inline-code examples or attributed HTML tags as placeholders', () => {
    const content = [
      '# API Reference',
      '',
      '## Examples',
      'Render a link with `<a href="/docs">Docs</a>` in the template.',
      'Inline generic `<T, U>` and a self-closing `<br />` are fine.',
      'Raw HTML in prose: <img src="diagram.png" alt="flow"> and <br />.',
      'A commented note: <!-- TODO: revisit later -->',
    ].join('\n')
    const analysis = analyzeDocStructure({ content, requiredSections: ['Examples'] })
    // No leftover-skeleton markers: the angle brackets are real HTML / inline code, and the
    // only TODO lives inside an HTML comment (stripped before the scan).
    expect(analysis.placeholders).toEqual([])
    expect(analysis.missingSections).toEqual([])
  })

  it('still flags a genuine prose angle-bracket placeholder', () => {
    const analysis = analyzeDocStructure({
      content: '# Doc\n\n## Overview\nReplace <your service name> before shipping.',
      requiredSections: ['Overview'],
    })
    expect(analysis.placeholders).toContain('<…> placeholder')
  })

  it('ignores a markdown link written as an inline-code example', () => {
    const content = [
      '# Doc',
      '',
      'A real link [guide](./guide.md), but `[not a link](./nope.md)` is just an example.',
    ].join('\n')
    const analysis = analyzeDocStructure({ content, requiredSections: [] })
    expect(analysis.relativeLinks).toEqual(['./guide.md'])
  })

  it('recognizes setext headings (=== / ---) for the H1 and section checks', () => {
    const content = ['Login PRD', '=========', '', 'Overview', '--------', 'What we build.'].join(
      '\n',
    )
    const analysis = analyzeDocStructure({ content, requiredSections: ['Overview'] })
    // The setext H1 satisfies the top-level-title rule; the setext H2 matches the section.
    expect(analysis.headingIssues).toEqual([])
    expect(analysis.missingSections).toEqual([])
  })

  it('does not treat a thematic break or YAML front matter as a setext heading', () => {
    const content = [
      '---',
      'title: Login PRD',
      '---',
      '# Login PRD',
      '',
      'Some prose.',
      '',
      '---',
      '',
      '## Overview',
      'text',
    ].join('\n')
    const analysis = analyzeDocStructure({ content, requiredSections: ['Overview'] })
    // Front matter is stripped (so `title: Login PRD` is not a setext H2), and the `---` after
    // a blank line is a thematic break, not a heading — so exactly one H1 remains.
    expect(analysis.headingIssues).toEqual([])
    expect(analysis.missingSections).toEqual([])
  })

  it('flags a missing top-level title, duplicate H1, and a skipped heading level', () => {
    const noH1 = analyzeDocStructure({ content: '## Overview\ntext', requiredSections: [] })
    expect(noH1.headingIssues.some((i) => i.includes('no top-level'))).toBe(true)

    const twoH1 = analyzeDocStructure({ content: '# A\n# B\n', requiredSections: [] })
    expect(twoH1.headingIssues.some((i) => i.includes('2 top-level'))).toBe(true)

    const skip = analyzeDocStructure({ content: '# A\n### Deep\n', requiredSections: [] })
    expect(skip.headingIssues.some((i) => i.includes('skipped'))).toBe(true)
  })

  it('extracts repo-relative links only (external URLs, anchors, mailto excluded)', () => {
    const content = [
      '# Doc',
      '',
      'See [the guide](../guide.md#usage) and [root](/docs/root.md).',
      'External [site](https://example.com) and [top](#overview) and [mail](mailto:x@y.z).',
      '![diagram](./img/flow.png)',
    ].join('\n')
    const analysis = analyzeDocStructure({ content, requiredSections: [] })
    expect(analysis.relativeLinks.sort()).toEqual(
      ['../guide.md', './img/flow.png', '/docs/root.md'].sort(),
    )
  })
})

describe('resolveDocLinkPath', () => {
  it('resolves a link against the document directory and collapses ./ and ../', () => {
    expect(resolveDocLinkPath('docs/prd/login.md', './assets/x.png')).toBe('docs/prd/assets/x.png')
    expect(resolveDocLinkPath('docs/prd/login.md', '../rfc/y.md')).toBe('docs/rfc/y.md')
    expect(resolveDocLinkPath('docs/prd/login.md', 'sibling.md')).toBe('docs/prd/sibling.md')
  })

  it('treats a leading-slash link as repo-root-relative', () => {
    expect(resolveDocLinkPath('docs/prd/login.md', '/README.md')).toBe('README.md')
  })

  it('returns null for a link that climbs past the repo root', () => {
    expect(resolveDocLinkPath('docs/x.md', '../../escape.md')).toBeNull()
  })
})
