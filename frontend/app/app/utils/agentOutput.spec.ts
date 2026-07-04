import { describe, it, expect } from 'vitest'
import { parseOutputOutline, renderMarkdown, sliceSource } from '~/utils/agentOutput'

describe('parseOutputOutline', () => {
  it('splits on headings and builds a ToC', () => {
    const out = parseOutputOutline(
      ['# Overview', 'intro text', '', '## Findings', '- a', '- b'].join('\n'),
    )
    expect(out.hasToc).toBe(true)
    expect(out.minDepth).toBe(1)
    expect(out.sections.map((s) => s.title)).toEqual(['Overview', 'Findings'])
    expect(out.sections[0]!.depth).toBe(1)
    expect(out.sections[1]!.depth).toBe(2)
    const findings = out.sections[1]!.bodyHtml
    // top-level blocks now carry data-src-* anchors, so match the open tag loosely
    expect(findings).toContain('<ul')
    expect(findings).toContain('<li>a</li>')
  })

  it('keeps text before the first heading as an untitled preamble (no ToC entry)', () => {
    const out = parseOutputOutline('loose intro\n\n## Section')
    expect(out.sections[0]!.title).toBe('')
    expect(out.sections[0]!.depth).toBe(0)
    expect(out.sections[0]!.bodyHtml).toContain('loose intro')
    expect(out.sections.filter((s) => s.depth > 0)).toHaveLength(1)
  })

  it('reports no ToC when there are no headings', () => {
    const out = parseOutputOutline('just a paragraph of prose')
    expect(out.hasToc).toBe(false)
    expect(out.sections).toHaveLength(1)
  })

  it('gives every section a unique id even with duplicate titles', () => {
    const out = parseOutputOutline('## Risks\na\n## Risks\nb')
    const ids = out.sections.map((s) => s.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('captures fenced code verbatim without treating its lines as headings', () => {
    const out = parseOutputOutline('## Code\n```ts\nconst x = 1\n# not a heading\n```')
    expect(out.sections).toHaveLength(1)
    const body = out.sections[0]!.bodyHtml
    expect(body).toContain('<pre>')
    expect(body).toContain('# not a heading')
  })

  it('escapes raw HTML rather than injecting it (html: false)', () => {
    const out = parseOutputOutline('## S\n<img src=x onerror=alert(1)>')
    const body = out.sections[0]!.bodyHtml
    expect(body).not.toContain('<img')
    expect(body).toContain('&lt;img')
  })

  it('renders inline marks and decorates links to open safely in a new tab', () => {
    const out = parseOutputOutline('## S\nsee **bold** and [site](https://example.com)')
    const body = out.sections[0]!.bodyHtml
    expect(body).toContain('<strong>bold</strong>')
    expect(body).toContain('href="https://example.com"')
    expect(body).toContain('target="_blank"')
    expect(body).toContain('rel="noopener noreferrer"')
  })

  it('does not create a link for javascript: URLs (markdown-it validateLink)', () => {
    // validateLink rejects the scheme, so it stays inert plain text — never an <a>.
    const out = parseOutputOutline('## S\n[x](javascript:alert(1))')
    const body = out.sections[0]!.bodyHtml
    expect(body).not.toContain('<a ')
    expect(body).not.toContain('href')
  })

  it('tolerates empty / nullish input', () => {
    expect(parseOutputOutline('').sections).toHaveLength(0)
    expect(parseOutputOutline(undefined as unknown as string).sections).toHaveLength(0)
  })
})

describe('renderMarkdown', () => {
  it('renders inline marks and preserves single newlines as breaks', () => {
    const html = renderMarkdown('see **bold** and _em_\nnext line')
    expect(html).toContain('<strong>bold</strong>')
    expect(html).toContain('<em>em</em>')
    expect(html).toContain('<br')
  })

  it('renders lists and fenced code', () => {
    const html = renderMarkdown(['- a', '- b', '', '```', 'const x = 1', '```'].join('\n'))
    expect(html).toContain('<ul')
    expect(html).toContain('<li>a</li>')
    expect(html).toContain('<pre>')
    expect(html).toContain('const x = 1')
  })

  it('escapes raw HTML rather than injecting it (html: false)', () => {
    const html = renderMarkdown('<img src=x onerror=alert(1)>')
    expect(html).not.toContain('<img')
    expect(html).toContain('&lt;img')
  })

  it('decorates links to open safely in a new tab', () => {
    const html = renderMarkdown('[site](https://example.com)')
    expect(html).toContain('href="https://example.com"')
    expect(html).toContain('target="_blank"')
    expect(html).toContain('rel="noopener noreferrer"')
  })

  it('does not create a link for javascript: URLs', () => {
    const html = renderMarkdown('[x](javascript:alert(1))')
    expect(html).not.toContain('<a ')
    expect(html).not.toContain('href')
  })

  it('renders empty string for empty / nullish input', () => {
    expect(renderMarkdown('')).toBe('')
    expect(renderMarkdown('   ')).toBe('')
    expect(renderMarkdown(null)).toBe('')
    expect(renderMarkdown(undefined)).toBe('')
  })
})

describe('sliceSource', () => {
  it('returns the verbatim line range (0-based, end-exclusive)', () => {
    const text = ['line0', 'line1', 'line2', 'line3'].join('\n')
    expect(sliceSource(text, 1, 3)).toBe('line1\nline2')
    expect(sliceSource(text, 0, 1)).toBe('line0')
  })

  it('tolerates nullish input', () => {
    expect(sliceSource(undefined as unknown as string, 0, 1)).toBe('')
  })
})

describe('source-line stamping (approval-mode block anchors)', () => {
  // Find a rendered block by its text and round-trip its `data-src-*` range back
  // through `sliceSource` against the ORIGINAL output — this is the contract the
  // approval reader relies on to quote the agent's own markdown back to it.
  const blockFor = (output: string, contains: string) => {
    const { sections } = parseOutputOutline(output)
    const host = document.createElement('div')
    host.innerHTML = sections.map((s) => s.bodyHtml).join('\n')
    const el = Array.from(host.querySelectorAll('[data-src-start]')).find((e) =>
      (e.textContent ?? '').includes(contains),
    )
    if (!el) throw new Error(`no source-stamped block containing "${contains}"`)
    return {
      start: Number(el.getAttribute('data-src-start')),
      end: Number(el.getAttribute('data-src-end')),
    }
  }

  it('round-trips a paragraph block to its original source lines', () => {
    const output = ['## Summary', '', 'First paragraph.', '', 'Second paragraph here.'].join('\n')
    const { start, end } = blockFor(output, 'First paragraph.')
    expect(sliceSource(output, start, end)).toBe('First paragraph.')
  })

  it('round-trips a multi-line fenced code block verbatim', () => {
    const code = ['```ts', 'const x = 1', 'const y = 2', '```'].join('\n')
    const output = ['## Code', '', code].join('\n')
    const { start, end } = blockFor(output, 'const x = 1')
    expect(sliceSource(output, start, end)).toBe(code)
  })

  it('stamps top-level blocks only (a comment targets a whole block, not a nested item)', () => {
    const output = ['Intro paragraph.', '', '- item one', '- item two'].join('\n')
    const { start, end } = blockFor(output, 'item one')
    // The whole list is the top-level block, so the slice spans both items.
    expect(sliceSource(output, start, end)).toContain('- item one')
    expect(sliceSource(output, start, end)).toContain('- item two')
  })
})
