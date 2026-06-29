import { describe, expect, it } from 'vitest'
import { renderDesignContext } from './design.logic.js'
import {
  assertSafeZeplinUrl,
  buildZeplinDesignContext,
  parseZeplinRef,
  splitZeplinExternalId,
  unwrapArray,
  unwrapObject,
  zeplinTokens,
  zeplinUrlFor,
} from './zeplin.logic.js'

describe('parseZeplinRef', () => {
  it('parses a project+screen URL', () => {
    expect(parseZeplinRef('https://app.zeplin.io/project/abc123/screen/def456')).toBe(
      'abc123:def456',
    )
  })

  it('parses a whole-project URL with no screen', () => {
    expect(parseZeplinRef('https://app.zeplin.io/project/abc123')).toBe('abc123')
    expect(parseZeplinRef('https://app.zeplin.io/project/abc123/styleguide/components')).toBe(
      'abc123',
    )
  })

  it('accepts a bare project id and a projectId:screenId form', () => {
    expect(parseZeplinRef('abc123')).toBe('abc123')
    expect(parseZeplinRef('abc123:def456')).toBe('abc123:def456')
  })

  it('rejects non-zeplin hosts and unparseable input', () => {
    expect(parseZeplinRef('https://evil.com/project/abc123')).toBeNull()
    expect(parseZeplinRef('https://app.zeplin.io.evil.com/project/abc')).toBeNull()
    expect(parseZeplinRef('   ')).toBeNull()
    expect(parseZeplinRef('not a ref!')).toBeNull()
  })

  it('canonicalises a pasted link and the stored canonical url to the SAME id', () => {
    // The auto-match path resolves a pasted task link by its external id, not URL-string
    // equality — so a pasted Zeplin URL and the canonical url zeplinUrlFor() stores MUST
    // parse to the same external id, or the design context never reaches the agent.
    const externalId = 'abc123:def456'
    const pasted = 'https://app.zeplin.io/project/abc123/screen/def456?foo=bar'
    expect(parseZeplinRef(pasted)).toBe(externalId)
    expect(parseZeplinRef(zeplinUrlFor(externalId))).toBe(externalId)
  })
})

describe('splitZeplinExternalId / zeplinUrlFor', () => {
  it('round-trips project + screen to a canonical URL', () => {
    expect(splitZeplinExternalId('p:s')).toEqual({ projectId: 'p', screenId: 's' })
    expect(splitZeplinExternalId('p')).toEqual({ projectId: 'p' })
    expect(zeplinUrlFor('p:s')).toBe('https://app.zeplin.io/project/p/screen/s')
    expect(zeplinUrlFor('p')).toBe('https://app.zeplin.io/project/p')
  })
})

describe('assertSafeZeplinUrl (SSRF host pin)', () => {
  it('accepts the fixed API host over https', () => {
    expect(() => assertSafeZeplinUrl('https://api.zeplin.dev/v1/projects/p')).not.toThrow()
  })
  it('rejects an off-host redirect, http downgrade, and garbage', () => {
    expect(() => assertSafeZeplinUrl('https://169.254.169.254/latest/meta-data')).toThrow(
      /disallowed host/,
    )
    expect(() => assertSafeZeplinUrl('http://api.zeplin.dev/v1/projects/p')).toThrow(/https/)
    expect(() => assertSafeZeplinUrl('https://api.zeplin.dev.evil.com/x')).toThrow(
      /disallowed host/,
    )
    expect(() => assertSafeZeplinUrl('not a url')).toThrow(/invalid/)
  })
})

describe('buildZeplinDesignContext + renderDesignContext', () => {
  it('renders screens as blocks, grouped components, and design tokens', () => {
    const ctx = buildZeplinDesignContext({
      externalId: 'proj1:scr1',
      projectName: 'Acme App',
      screens: [
        {
          id: 'scr1',
          name: 'Login',
          description: 'Sign-in screen',
          image: { width: 390, height: 844 },
        },
      ],
      components: [
        { name: 'Primary Button', section: { name: 'Actions' }, description: '3 sizes' },
        { name: 'Text Field', section: { name: 'Forms' } },
      ],
      designTokens: {
        colors: [{ name: 'brand/primary', r: 255, g: 0, b: 0, a: 1 }],
        spacing: [{ name: 'space/sm', value: 8 }],
      },
    })
    expect(ctx.title).toBe('Acme App — Login')
    expect(ctx.url).toBe('https://app.zeplin.io/project/proj1/screen/scr1')
    const md = renderDesignContext(ctx)
    expect(md).toContain('## Login (390×844)')
    expect(md).toContain('### Description')
    expect(md).toContain('Sign-in screen')
    expect(md).toContain('### Components')
    expect(md).toContain('- Actions › Primary Button — 3 sizes')
    expect(md).toContain('- Forms › Text Field')
    expect(md).toContain('### Design tokens')
    expect(md).toContain('- Colors › brand/primary = #ff0000')
    expect(md).toContain('- Spacing › space/sm = 8')
  })

  it('uses the project name when no screen is referenced and omits empty sections', () => {
    const ctx = buildZeplinDesignContext({
      externalId: 'proj1',
      projectName: 'Acme App',
      screens: [],
      components: [],
      designTokens: null,
    })
    expect(ctx.title).toBe('Acme App')
    expect(renderDesignContext(ctx)).toBe('')
  })
})

describe('zeplinTokens', () => {
  it('maps colours, typography and spacing; ignores nameless entries', () => {
    expect(
      zeplinTokens({
        colors: [
          { name: 'c', r: 0, g: 128, b: 255, a: 0.5 },
          { r: 1, g: 1, b: 1 },
        ],
        text_styles: [{ name: 'body', font_family: 'Inter', font_size: 14 }],
      }),
    ).toEqual([
      { collection: 'Colors', name: 'c', value: '#0080ff (a=0.50)' },
      { collection: 'Typography', name: 'body', value: 'Inter 14px' },
    ])
    expect(zeplinTokens(undefined)).toEqual([])
  })
})

describe('unwrapArray / unwrapObject (Zeplin response envelopes)', () => {
  it('reads a bare array or a { key: [...] } envelope, else []', () => {
    expect(unwrapArray([{ a: 1 }], 'screens')).toEqual([{ a: 1 }])
    expect(unwrapArray({ screens: [{ a: 1 }] }, 'screens')).toEqual([{ a: 1 }])
    expect(unwrapArray({ other: [1] }, 'screens')).toEqual([])
    expect(unwrapArray(null, 'screens')).toEqual([])
  })

  it('reads a bare object or a { key: {...} } envelope, else null', () => {
    expect(unwrapObject({ id: 's1' }, 'screen')).toEqual({ id: 's1' })
    expect(unwrapObject({ screen: { id: 's1' } }, 'screen')).toEqual({ id: 's1' })
    expect(unwrapObject(null, 'screen')).toBeNull()
    expect(unwrapObject('nope', 'screen')).toBeNull()
  })
})
