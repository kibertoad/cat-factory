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
