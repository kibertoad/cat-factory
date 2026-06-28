import { describe, expect, it } from 'vitest'
import {
  assertSafeClaudeDesignUrl,
  claudeDesignUrlFor,
  dsCardsToMarkdown,
  extractCssTokens,
  htmlToText,
  parseClaudeDesignRef,
  parseDsCardComment,
  parseDsManifest,
  renderClaudeDesignProject,
  splitClaudeDesignExternalId,
} from './claudeDesign.logic.js'

describe('parseClaudeDesignRef', () => {
  it('parses a project URL', () => {
    expect(parseClaudeDesignRef('https://claude.ai/design/proj_ABC123')).toBe('proj_ABC123')
  })
  it('parses a /files/ component URL into the composite id', () => {
    expect(
      parseClaudeDesignRef('https://claude.ai/design/proj_ABC123/files/components/button.html'),
    ).toBe('proj_ABC123::components/button.html')
  })
  it('parses a ?file= query into the composite id', () => {
    expect(
      parseClaudeDesignRef('https://claude.ai/design/proj_ABC123?file=components/card.html&x=1'),
    ).toBe('proj_ABC123::components/card.html')
  })
  it('accepts a bare project id and the composite form', () => {
    expect(parseClaudeDesignRef('proj_ABC123')).toBe('proj_ABC123')
    expect(parseClaudeDesignRef('proj_ABC123::components/button.html')).toBe(
      'proj_ABC123::components/button.html',
    )
  })
  it('rejects non-claude hosts and unparseable input', () => {
    expect(parseClaudeDesignRef('https://evil.com/design/proj_ABC')).toBeNull()
    expect(parseClaudeDesignRef('https://claude.ai.evil.com/design/x')).toBeNull()
    expect(parseClaudeDesignRef('https://claude.ai/projects/x')).toBeNull()
    expect(parseClaudeDesignRef('   ')).toBeNull()
    expect(parseClaudeDesignRef('not a ref!')).toBeNull()
  })
})

describe('splitClaudeDesignExternalId / claudeDesignUrlFor', () => {
  it('round-trips project id + file path to a canonical URL', () => {
    expect(splitClaudeDesignExternalId('proj::a/b.html')).toEqual({
      projectId: 'proj',
      filePath: 'a/b.html',
    })
    expect(splitClaudeDesignExternalId('proj')).toEqual({ projectId: 'proj' })
    expect(claudeDesignUrlFor('proj::a/b.html')).toBe(
      'https://claude.ai/design/proj/files/a/b.html',
    )
    expect(claudeDesignUrlFor('proj')).toBe('https://claude.ai/design/proj')
  })
})

describe('assertSafeClaudeDesignUrl (SSRF host pin)', () => {
  it('accepts the fixed API host over https', () => {
    expect(() =>
      assertSafeClaudeDesignUrl('https://api.claude.com/v1/design/projects/x/files'),
    ).not.toThrow()
  })
  it('rejects an off-host redirect, http downgrade, and garbage', () => {
    expect(() => assertSafeClaudeDesignUrl('https://169.254.169.254/latest/meta-data')).toThrow(
      /disallowed host/,
    )
    expect(() => assertSafeClaudeDesignUrl('http://api.claude.com/v1/x')).toThrow(/https/)
    expect(() => assertSafeClaudeDesignUrl('https://api.claude.com.evil.com/x')).toThrow(
      /disallowed host/,
    )
    expect(() => assertSafeClaudeDesignUrl('not a url')).toThrow(/invalid/)
  })
})

describe('parseDsManifest', () => {
  it('parses a bare array and a { cards } envelope', () => {
    expect(parseDsManifest([{ name: 'Primary', group: 'Buttons', subtitle: '3 sizes' }])).toEqual([
      { name: 'Primary', group: 'Buttons', subtitle: '3 sizes' },
    ])
    expect(parseDsManifest({ cards: [{ name: 'Card', path: 'card.html' }] })).toEqual([
      { name: 'Card', path: 'card.html' },
    ])
  })
  it('drops junk entries and unknown shapes', () => {
    expect(parseDsManifest({ nope: true })).toEqual([])
    expect(parseDsManifest([null, 3, { group: 'x' }])).toEqual([])
  })
})

describe('parseDsCardComment', () => {
  it('reads the @dsCard marker attributes', () => {
    const html =
      '<!-- @dsCard group="Forms" name="Text input" subtitle="default / error" -->\n<div>'
    expect(parseDsCardComment(html)).toEqual({
      group: 'Forms',
      name: 'Text input',
      subtitle: 'default / error',
    })
  })
  it('returns null when there is no marker', () => {
    expect(parseDsCardComment('<div>no marker</div>')).toBeNull()
  })
})

describe('extractCssTokens', () => {
  it('extracts custom properties, dedupes (last wins), sorts, drops var() aliases', () => {
    const css = `:root{--color-primary:#ff0000;--space-sm:8px;--color-primary:#00ff00;--alias:var(--space-sm)}`
    expect(extractCssTokens(css)).toEqual(['--color-primary = #00ff00', '--space-sm = 8px'])
  })
})

describe('htmlToText', () => {
  it('strips scripts/styles/tags and collapses whitespace', () => {
    const html =
      '<style>.x{color:red}</style><h1>Hi</h1><script>alert(1)</script><p>There  &amp; you</p>'
    expect(htmlToText(html)).toBe('Hi There & you')
  })
})

describe('dsCardsToMarkdown', () => {
  it('renders a grouped, de-duplicated component inventory', () => {
    const md = dsCardsToMarkdown([
      { name: 'Primary', group: 'Buttons', subtitle: '3 sizes' },
      { name: 'Secondary', group: 'Buttons' },
      { name: 'Primary', group: 'Buttons' }, // dup name in group → collapsed
      { name: 'Text input', group: 'Forms' },
    ])
    expect(md).toContain('### Components')
    expect(md).toContain('#### Buttons')
    expect(md).toContain('- Primary — 3 sizes')
    expect(md).toContain('- Secondary')
    expect(md).toContain('#### Forms')
    expect(md).toContain('- Text input')
    // Buttons sorts before Forms; Primary appears once.
    expect(md.match(/- Primary/g)).toHaveLength(1)
  })
  it('returns empty string for no cards', () => {
    expect(dsCardsToMarkdown([])).toBe('')
  })
})

describe('renderClaudeDesignProject', () => {
  it('prefers the manifest for the component inventory and unions CSS tokens', () => {
    const md = renderClaudeDesignProject('Acme DS', [
      {
        path: '_ds_manifest.json',
        content: JSON.stringify({
          name: 'Acme DS',
          cards: [{ name: 'Primary', group: 'Buttons' }],
        }),
      },
      { path: 'tokens.css', content: ':root{--color-primary:#ff0000;--space-sm:8px}' },
      { path: 'components/button.html', content: '<!-- @dsCard group="Ignored" name="X" -->' },
    ])
    expect(md).toContain('## Acme DS')
    expect(md).toContain('### Components')
    expect(md).toContain('#### Buttons')
    expect(md).toContain('- Primary')
    // Manifest wins → the HTML @dsCard ("X"/"Ignored") is not used.
    expect(md).not.toContain('Ignored')
    expect(md).toContain('### Design tokens')
    expect(md).toContain('- --color-primary = #ff0000')
    expect(md).toContain('- --space-sm = 8px')
  })

  it('recovers the inventory from @dsCard markers when there is no manifest', () => {
    const md = renderClaudeDesignProject('proj', [
      {
        path: 'components/button.html',
        content: '<!-- @dsCard group="Buttons" name="Primary" -->\n<style>:root{--c:#fff}</style>',
      },
      {
        path: 'components/card.html',
        content: '<!-- @dsCard group="Surfaces" name="Card" -->',
      },
    ])
    expect(md).toContain('#### Buttons')
    expect(md).toContain('- Primary')
    expect(md).toContain('#### Surfaces')
    expect(md).toContain('- Card')
    expect(md).toContain('- --c = #fff')
  })

  it('folds in visible text for a single-component import', () => {
    const md = renderClaudeDesignProject('proj', [
      { path: 'button.html', content: '<h1>Primary button</h1><p>Use for the main action.</p>' },
    ])
    expect(md).toContain('### Content')
    expect(md).toContain('Primary button Use for the main action.')
  })
})
