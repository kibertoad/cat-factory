import { describe, expect, it } from 'vitest'
import { hostMarkdown } from '@cat-factory/kernel'
import { markdownToAdf, markdownToAdfWithin } from './markdown-adf.logic.js'

describe('markdownToAdf', () => {
  it('maps headings, paragraphs and bullet lists', () => {
    const doc = markdownToAdf('# Title\n\nSome prose.\n\n- one\n- two')
    expect(doc.type).toBe('doc')
    expect(doc.content[0]).toMatchObject({ type: 'heading', attrs: { level: 1 } })
    expect(doc.content[1]).toMatchObject({ type: 'paragraph' })
    expect(doc.content[2]).toMatchObject({ type: 'bulletList' })
    expect(doc.content[2]!.content).toHaveLength(2)
  })

  it('never yields empty content (ADF requires non-empty)', () => {
    expect(markdownToAdf('').content).toEqual([{ type: 'paragraph', content: [] }])
  })

  it('keeps the nesting of a requirement and its acceptance criteria', () => {
    const doc = markdownToAdf(
      [
        '## Functional Requirements',
        '- **must**: The system SHALL export invoices.',
        '  Acceptance:',
        '  - Given an invoice, When exported, Then a PDF is produced.',
        '  - Given no invoices, When exported, Then nothing is produced.',
        '- **should**: The system SHALL email the export.',
      ].join('\n'),
    )
    expect(doc.content[0]).toMatchObject({ type: 'heading', attrs: { level: 2 } })
    const list = doc.content[1]!
    expect(list.type).toBe('bulletList')
    expect(list.content).toHaveLength(2)
    const first = list.content![0] as { content: { type: string; content?: unknown[] }[] }
    expect(first.content.map((block) => block.type)).toEqual(['paragraph', 'bulletList'])
    expect(first.content[0]!.content).toEqual([
      { type: 'text', text: 'must', marks: [{ type: 'strong' }] },
      { type: 'text', text: ': The system SHALL export invoices.' },
      { type: 'hardBreak' },
      { type: 'text', text: 'Acceptance:' },
    ])
    expect(first.content[1]!.content).toHaveLength(2)
  })

  it('maps ordered lists, fenced code, quotes and rules', () => {
    const doc = markdownToAdf('3. third\n4. fourth\n\n```ts\nconst a = 1\n```\n\n> quoted\n\n---')
    expect(doc.content.map((block) => block.type)).toEqual([
      'orderedList',
      'codeBlock',
      'blockquote',
      'rule',
    ])
    expect(doc.content[0]!.attrs).toEqual({ order: 3 })
    expect(doc.content[1]).toEqual({
      type: 'codeBlock',
      attrs: { language: 'ts' },
      content: [{ type: 'text', text: 'const a = 1' }],
    })
  })

  it('maps inline code, emphasis and safe links, and leaves snake_case alone', () => {
    const [paragraph] = markdownToAdf(
      'Use `run_id` with _care_ via [docs](https://example.com/a) not [x](javascript:alert) or snake_case_name',
    ).content
    expect(paragraph!.content).toEqual([
      { type: 'text', text: 'Use ' },
      { type: 'text', text: 'run_id', marks: [{ type: 'code' }] },
      { type: 'text', text: ' with ' },
      { type: 'text', text: 'care', marks: [{ type: 'em' }] },
      { type: 'text', text: ' via ' },
      {
        type: 'text',
        text: 'docs',
        marks: [{ type: 'link', attrs: { href: 'https://example.com/a' } }],
      },
      { type: 'text', text: ' not x or snake_case_name' },
    ])
  })

  it('decodes the entities hostMarkdown writes, because ADF text never auto-links', () => {
    const [paragraph] = markdownToAdf('Ask &#64;alice about &#35;42').content
    expect(paragraph!.content).toEqual([{ type: 'text', text: 'Ask @alice about #42' }])
  })

  it('decodes a defused link destination before it becomes a link target', () => {
    const defused = hostMarkdown.prose(
      'See [post](https://medium.com/@alice/x) and [spec](https://x.test/doc#1)',
      1_000,
    )
    const [paragraph] = markdownToAdf(defused).content
    const hrefs = (paragraph!.content as { marks?: { attrs?: { href?: string } }[] }[])
      .flatMap((node) => node.marks ?? [])
      .map((mark) => mark.attrs?.href)
    expect(hrefs).toEqual(['https://medium.com/@alice/x', 'https://x.test/doc#1'])
  })

  it('flattens a nested quote into its parent rather than dropping its text', () => {
    const [quote] = markdownToAdf('> outer\n>\n> > inner text').content
    expect(quote).toEqual({
      type: 'blockquote',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'outer' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'inner text' }] },
      ],
    })
  })
})

describe('markdownToAdfWithin', () => {
  const NOTE = '(cut)'
  const size = (doc: unknown) => JSON.stringify(doc).length

  it('returns the whole conversion when it fits', () => {
    expect(markdownToAdfWithin('- a\n- b', 10_000, NOTE)).toEqual(markdownToAdf('- a\n- b'))
  })

  it('sizes the cut on the serialized ADF, which outgrows the Markdown', () => {
    // A bullet-heavy document: well under the limit as Markdown, several times over as ADF.
    const markdown = Array.from({ length: 400 }, (_, i) => `- **r${i}**: x`).join('\n')
    const limit = 8_000
    expect(markdown.length).toBeLessThan(limit)
    expect(size(markdownToAdf(markdown))).toBeGreaterThan(limit)

    const doc = markdownToAdfWithin(markdown, limit, NOTE)
    expect(size(doc)).toBeLessThanOrEqual(limit)
    expect(doc.content.at(-1)).toEqual({
      type: 'paragraph',
      content: [{ type: 'text', text: NOTE }],
    })
    // A line-boundary prefix was kept, not just the note.
    const list = doc.content[0] as { type: string; content: unknown[] }
    expect(list.type).toBe('bulletList')
    expect(list.content.length).toBeGreaterThan(10)
    expect(list.content.length).toBeLessThan(400)
  })
})
