import { describe, expect, it } from 'vitest'
import {
  analyzeDocStructure,
  documentHeadings,
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

describe('documentHeadings', () => {
  const texts = (content: string) => documentHeadings(content).map((h) => `H${h.level} ${h.text}`)

  describe('ATX headings', () => {
    it('reads the level from the hash run and the full text after it', () => {
      expect(texts('# Title\n## Section\n###### Deepest\n')).toEqual([
        'H1 Title',
        'H2 Section',
        'H6 Deepest',
      ])
    })

    it('drops a closing hash sequence but keeps hashes inside the text', () => {
      expect(texts('# Title #\n')).toEqual(['H1 Title'])
      expect(texts('## Issue #123\n')).toEqual(['H2 Issue #123'])
    })

    it('needs the hashes at the START of the line and a space after them', () => {
      expect(texts('see the # Section below\n')).toEqual([])
      expect(texts('#Title\n')).toEqual([])
      // Seven hashes is past the maximum depth, so it is not a heading at all.
      expect(texts('####### Too deep\n')).toEqual([])
    })
  })

  describe('setext headings', () => {
    it('reads === as an H1 and --- as an H2', () => {
      expect(texts('Title\n=====\n\nSection\n-------\n')).toEqual(['H1 Title', 'H2 Section'])
    })

    it('needs the underline to be the WHOLE line', () => {
      expect(texts('# T\n\nIntro\nbeta ===\n')).toEqual(['H1 T'])
      // A bullet list under a paragraph is not an underline, though it starts with a dash.
      expect(texts('# T\n\nIntro\n- item\n')).toEqual(['H1 T'])
      // Trailing spaces/tabs after the rule ARE allowed.
      expect(texts('Title\n===  \n')).toEqual(['H1 Title'])
      // More than three leading spaces makes it indented code, not an underline.
      expect(texts('Title\n    ===\n')).toEqual([])
    })

    it('never treats the first line of a document as an underline', () => {
      // There is no preceding line to title, so this must be a thematic break, not a crash.
      expect(texts('===\n\n# Title\n')).toEqual(['H1 Title'])
      expect(texts('===\n')).toEqual([])
    })

    it('refuses a rule whose preceding line cannot be a title', () => {
      expect(texts('# T\n\n\n===\n')).toEqual(['H1 T']) // blank line above: thematic break
      expect(texts('# Already a heading\n===\n')).toEqual(['H1 Already a heading'])
      expect(texts('===\n---\n')).toEqual([]) // an underline above an underline
    })
  })

  describe('front matter and fenced code', () => {
    it('strips a leading front-matter block so its keys are not read as content', () => {
      expect(texts('---\ntitle: x\n# not a heading\n---\n\n# Real\n')).toEqual(['H1 Real'])
      // Terminated by EOF rather than a newline.
      expect(texts('---\ntitle: x\n---')).toEqual([])
      // Trailing spaces on the delimiters are tolerated.
      expect(texts('--- \ntitle: x\n--- \n\n# Real\n')).toEqual(['H1 Real'])
    })

    it('only strips front matter at the very START of the document', () => {
      // Mid-document the same three lines are ordinary Markdown, so `title: x` underlined by
      // `---` is a setext H2 — which is the point: only a LEADING block is config.
      expect(texts('# Real\n\n---\ntitle: x\n---\n\n## After\n')).toEqual([
        'H1 Real',
        'H2 title: x',
        'H2 After',
      ])
      // An indented opening delimiter is not front matter either.
      expect(texts(' ---\ntitle: x\n---\n\n# Real\n')).toEqual(['H2 title: x', 'H1 Real'])
    })

    it('strips a fenced block so its contents are not read as headings', () => {
      expect(texts('# Title\n\n```md\n# In code\n```\n\n## After\n')).toEqual([
        'H1 Title',
        'H2 After',
      ])
      expect(texts('# Title\n\n~~~\n# In code\n~~~\n\n## After\n')).toEqual([
        'H1 Title',
        'H2 After',
      ])
    })

    it('closes a fence only on the SAME character, at the same length or longer', () => {
      // A tilde line inside a backtick fence does not close it.
      expect(texts('# T\n\n````\n~~~\n# Hidden\n````\n\n## After\n')).toEqual(['H1 T', 'H2 After'])
      // A shorter run does not close a longer opener...
      expect(texts('# T\n\n````\n```\n# Hidden\n````\n\n## After\n')).toEqual(['H1 T', 'H2 After'])
      // ...while an equal or longer one does.
      expect(texts('# T\n\n```\n# Hidden\n```\n\n## After\n')).toEqual(['H1 T', 'H2 After'])
      expect(texts('# T\n\n```\n# Hidden\n`````\n\n## After\n')).toEqual(['H1 T', 'H2 After'])
    })

    it('accepts an indented fence, and does not treat inline code as one', () => {
      expect(texts('# T\n\n  ```\n  # Hidden\n  ```\n\n## After\n')).toEqual(['H1 T', 'H2 After'])
      // A single backtick opens nothing: the heading after it must still be found.
      expect(texts('`inline` prose\n\n# Title\n')).toEqual(['H1 Title'])
      expect(texts('~tilde~ prose\n\n# Title\n')).toEqual(['H1 Title'])
    })

    it('reads a CRLF document exactly like an LF one', () => {
      const lf = '---\ntitle: x\n---\n\n# Title\n\n```\n# Hidden\n```\n\n## After\n'
      expect(texts(lf.replace(/\n/g, '\r\n'))).toEqual(texts(lf))
      expect(texts(lf)).toEqual(['H1 Title', 'H2 After'])
    })
  })
})

describe('analyzeDocStructure — section matching', () => {
  const missing = (content: string, requiredSections: string[]) =>
    analyzeDocStructure({ content, requiredSections }).missingSections

  it('matches a renamed heading whose words are a SUPERSET of the section title', () => {
    expect(missing('# T\n## Risks and mitigations\n', ['Risks'])).toEqual([])
    // The other direction does not hold: a heading missing one of the section's words.
    expect(missing('# T\n## Risks\n', ['Risks and mitigations'])).toEqual(['Risks and mitigations'])
  })

  it('ignores case, emphasis and punctuation on both sides', () => {
    expect(missing('# T\n## **RISKS / Mitigations**\n', ['risks mitigations'])).toEqual([])
  })

  it('drops a trailing "(optional)" marker from the required title', () => {
    // The skeleton marks a section optional; the drafted document just calls it "Risks".
    expect(missing('# T\n## Risks\n', ['Risks (optional)'])).toEqual([])
  })

  it('ignores single-character words, which carry no matching signal', () => {
    expect(missing('# T\n## Plan\n', ['A Plan'])).toEqual([])
  })

  it('never reports a required section that has no significant words at all', () => {
    expect(missing('# T\n', ['—'])).toEqual([])
    expect(missing('# T\n', [''])).toEqual([])
  })
})

describe('analyzeDocStructure — placeholder scanning', () => {
  const placeholders = (content: string) =>
    analyzeDocStructure({ content, requiredSections: [] }).placeholders

  it('names each marker it finds, once', () => {
    expect(placeholders('# T\nTODO and TODO again, plus FIXME, XXX, TKTK, Lorem Ipsum.\n')).toEqual(
      ['TODO', 'TKTK', 'FIXME', 'XXX', 'Lorem ipsum'],
    )
  })

  it('is case-sensitive where the marker is an acronym and insensitive where it is prose', () => {
    expect(placeholders('# T\ntodo later\n')).toEqual([])
    expect(placeholders('# T\ntktk\n')).toEqual(['TKTK'])
    expect(placeholders('# T\nLOREM IPSUM dolor\n')).toEqual(['Lorem ipsum'])
  })

  it('needs a whole word, not a substring', () => {
    expect(placeholders('# T\nMastodont, xxxl, refixmeasure\n')).toEqual([])
  })

  it('does not let a stripped comment or code span JOIN two halves into a marker', () => {
    // Both are replaced by a SPACE, not removed: `TO<!--x-->DO` is "TO DO", not a TODO.
    expect(placeholders('# T\nTO<!--split-->DO\n')).toEqual([])
    expect(placeholders('# T\nTO`x`DO\n')).toEqual([])
  })

  it('strips a multi-backtick code span whole, rather than its outer backtick only', () => {
    expect(placeholders('# T\nWrite ``TODO`` in the template.\n')).toEqual([])
  })

  it('flags prose angle-bracket text but not a real tag', () => {
    expect(placeholders('# T\nSet <your service name> here.\n')).toEqual(['<…> placeholder'])
    expect(placeholders('# T\nUse <div> and <T> and <br /> and <a href="x">.\n')).toEqual([])
  })
})

describe('analyzeDocStructure — heading hierarchy', () => {
  const issues = (content: string) =>
    analyzeDocStructure({ content, requiredSections: [] }).headingIssues

  it('accepts exactly one H1 with no level skipped', () => {
    expect(issues('# T\n## A\n### A1\n## B\n')).toEqual([])
  })

  it('counts the H1s and names the number when there is more than one', () => {
    expect(issues('# One\n# Two\n# Three\n')).toEqual([
      'The document has 3 top-level (`#`) titles; use exactly one.',
    ])
  })

  it('never flags the FIRST heading as a skip, whatever its level', () => {
    // The missing-title rule already covers a document that opens at H3.
    expect(issues('### Deep start\n#### Deeper\n')).toEqual([
      'The document has no top-level (`#`) title.',
    ])
  })

  it('flags a jump of two levels or more, and allows any descent', () => {
    expect(issues('# T\n### Skipped\n')).toEqual([
      'Heading "Skipped" jumps from H1 to H3 (a heading level is skipped).',
    ])
    expect(issues('# T\n## A\n### A1\n#### A1a\n## B\n')).toEqual([])
  })
})

describe('analyzeDocStructure — relative links', () => {
  const links = (content: string) =>
    analyzeDocStructure({ content, requiredSections: [] }).relativeLinks

  it('reads both link and image targets, deduped in first-seen order', () => {
    expect(links('# T\n[a](./b.md) ![img](./c.png) [again](./b.md)\n')).toEqual([
      './b.md',
      './c.png',
    ])
  })

  it('accepts the angle-bracket target form and a trailing title', () => {
    expect(links('# T\n[d](./e.md "Title")\n')).toEqual(['./e.md'])
  })

  it('drops an anchor and a query from a relative target', () => {
    expect(links('# T\n[a](./b.md#section) [c](./d.md?x=1)\n')).toEqual(['./b.md', './d.md'])
  })

  it('excludes a pure anchor and every scheme-qualified or protocol-relative target', () => {
    expect(
      links(
        '# T\n[a](#top) [b](https://x/y) [c](HTTP://x/y) [d](mailto:a@b.c) [e](tel:123) ' +
          '[f](data:text/plain,x) [g](//cdn.example/x.png)\n',
      ),
    ).toEqual([])
  })

  it('does not read a link written as an inline-code example', () => {
    expect(links('# T\nWrite `[a](./b.md)` like this.\n')).toEqual([])
  })
})

describe('hasDocStructureIssues', () => {
  const clean = {
    missingSections: [],
    placeholders: [],
    headingIssues: [],
    relativeLinks: [],
  }

  it('is false for a clean analysis, links or not', () => {
    expect(hasDocStructureIssues(clean)).toBe(false)
    // Links are NOT an issue here: existence is the provider's job, so a document that merely
    // references files must not fail this check on its own.
    expect(hasDocStructureIssues({ ...clean, relativeLinks: ['./a.md'] })).toBe(false)
  })

  it('is true for each of the three structural problems on its own', () => {
    expect(hasDocStructureIssues({ ...clean, missingSections: ['Risks'] })).toBe(true)
    expect(hasDocStructureIssues({ ...clean, placeholders: ['TODO'] })).toBe(true)
    expect(hasDocStructureIssues({ ...clean, headingIssues: ['no title'] })).toBe(true)
  })
})

describe('resolveDocLinkPath — the remaining edges', () => {
  it('collapses empty and current-directory segments', () => {
    expect(resolveDocLinkPath('docs/a.md', './/b//c.md')).toBe('docs/b/c.md')
    expect(resolveDocLinkPath('docs/a.md', './././b.md')).toBe('docs/b.md')
  })

  it('resolves a document at the repo root against the root itself', () => {
    expect(resolveDocLinkPath('README.md', './docs/a.md')).toBe('docs/a.md')
    expect(resolveDocLinkPath('README.md', '../a.md')).toBeNull()
  })

  it('strips every leading slash of a root-relative link', () => {
    expect(resolveDocLinkPath('docs/deep/a.md', '//docs/b.md')).toBe('docs/b.md')
  })

  it('climbs no further than the root, and resolves a link back down again', () => {
    expect(resolveDocLinkPath('docs/deep/a.md', '../b.md')).toBe('docs/b.md')
    expect(resolveDocLinkPath('docs/deep/a.md', '../../b.md')).toBe('b.md')
    expect(resolveDocLinkPath('docs/deep/a.md', '../../../b.md')).toBeNull()
    expect(resolveDocLinkPath('docs/deep/a.md', '../other/b.md')).toBe('docs/other/b.md')
  })

  it('is null when the link resolves to nothing at all', () => {
    expect(resolveDocLinkPath('docs/a.md', '/')).toBeNull()
    expect(resolveDocLinkPath('a.md', './')).toBeNull()
  })
})
