import { describe, expect, it } from 'vitest'
import { renderDesignContext } from './design.logic.js'
import {
  assertSafeFigmaUrl,
  buildFigmaDesignContext,
  figmaTokens,
  figmaUrlFor,
  normalizeFigmaNodeId,
  parseFigmaRef,
  splitFigmaExternalId,
  type FigmaNode,
} from './figma.logic.js'

describe('parseFigmaRef', () => {
  it('parses a design URL with a node id (dash → colon)', () => {
    expect(
      parseFigmaRef('https://www.figma.com/design/abcDEF123/My-File?node-id=1234-5678&t=xy'),
    ).toBe('abcDEF123:1234:5678')
  })

  it('parses the legacy /file/ URL and a %3A-encoded node id', () => {
    expect(parseFigmaRef('https://figma.com/file/Key9/Title?node-id=12%3A34')).toBe('Key9:12:34')
  })

  it('parses a whole-file URL with no node id', () => {
    expect(parseFigmaRef('https://www.figma.com/design/abcDEF123/My-File')).toBe('abcDEF123')
  })

  it('accepts a bare file key and a fileKey:node:id form', () => {
    expect(parseFigmaRef('abcDEF123')).toBe('abcDEF123')
    expect(parseFigmaRef('abcDEF123:1:2')).toBe('abcDEF123:1:2')
  })

  it('drops a complex/instance node id rather than guessing (falls back to whole file)', () => {
    expect(parseFigmaRef('https://www.figma.com/design/K/Title?node-id=I12-3;45-6')).toBe('K')
  })

  it('rejects non-figma hosts and unparseable input', () => {
    expect(parseFigmaRef('https://evil.com/design/K/Title')).toBeNull()
    expect(parseFigmaRef('https://figma.com.evil.com/design/K')).toBeNull()
    expect(parseFigmaRef('   ')).toBeNull()
    expect(parseFigmaRef('not a ref!')).toBeNull()
  })

  it('canonicalises a noisy pasted link and the stored canonical url to the SAME id', () => {
    // The auto-match path (AgentContextBuilder.documentUrlResolver) resolves a pasted task
    // link by its external id, not by URL-string equality — so a real Figma share URL (with
    // a title segment, dash node id and tracking params) and the title-less canonical url
    // figmaUrlFor() stores at import time MUST parse to the same external id, or the design
    // context never reaches the agent.
    const externalId = 'abcDEF123:1234:5678'
    const pasted =
      'https://www.figma.com/design/abcDEF123/Marketing-Site?node-id=1234-5678&t=Ab1Cd2Ef3&m=dev'
    expect(parseFigmaRef(pasted)).toBe(externalId)
    expect(parseFigmaRef(figmaUrlFor(externalId))).toBe(externalId)
    expect(parseFigmaRef(pasted)).toBe(parseFigmaRef(figmaUrlFor(externalId)))
  })
})

describe('normalizeFigmaNodeId', () => {
  it('converts dash form, keeps colon form, accepts bare numeric', () => {
    expect(normalizeFigmaNodeId('1234-5678')).toBe('1234:5678')
    expect(normalizeFigmaNodeId('1234:5678')).toBe('1234:5678')
    expect(normalizeFigmaNodeId('42')).toBe('42')
  })
  it('rejects non-simple ids', () => {
    expect(normalizeFigmaNodeId('I12:3;45:6')).toBeNull()
    expect(normalizeFigmaNodeId('')).toBeNull()
  })
})

describe('splitFigmaExternalId / figmaUrlFor', () => {
  it('round-trips file key + node id to a canonical share URL', () => {
    expect(splitFigmaExternalId('Key:1:2')).toEqual({ fileKey: 'Key', nodeId: '1:2' })
    expect(splitFigmaExternalId('Key')).toEqual({ fileKey: 'Key' })
    expect(figmaUrlFor('Key:1:2')).toBe('https://www.figma.com/design/Key?node-id=1-2')
    expect(figmaUrlFor('Key')).toBe('https://www.figma.com/design/Key')
  })
})

describe('assertSafeFigmaUrl (SSRF host pin)', () => {
  it('accepts the fixed API host over https', () => {
    expect(() => assertSafeFigmaUrl('https://api.figma.com/v1/files/Key')).not.toThrow()
  })
  it('rejects an off-host redirect, http downgrade, and garbage', () => {
    expect(() => assertSafeFigmaUrl('https://169.254.169.254/latest/meta-data')).toThrow(
      /disallowed host/,
    )
    expect(() => assertSafeFigmaUrl('http://api.figma.com/v1/files/Key')).toThrow(/https/)
    expect(() => assertSafeFigmaUrl('https://api.figma.com.evil.com/x')).toThrow(/disallowed host/)
    expect(() => assertSafeFigmaUrl('not a url')).toThrow(/invalid/)
  })
})

describe('buildFigmaDesignContext + renderDesignContext', () => {
  const frame: FigmaNode = {
    id: '1:2',
    name: 'Login Card',
    type: 'FRAME',
    absoluteBoundingBox: { width: 320, height: 200 },
    children: [
      { name: 'Title', type: 'TEXT', characters: 'Sign in' },
      {
        name: 'PrimaryButton',
        type: 'INSTANCE',
        componentId: 'C1',
        children: [{ name: 'Label', type: 'TEXT', characters: 'Continue' }],
      },
    ],
  }

  it('renders frame heading, layout tree, text, and a global components section', () => {
    const ctx = buildFigmaDesignContext({
      externalId: 'abcDEF123:1:2',
      fileName: 'Marketing Site',
      nodeId: '1:2',
      roots: [frame],
      components: { C1: { name: 'Button/Primary' } },
    })
    expect(ctx.title).toBe('Marketing Site — Login Card')
    expect(ctx.url).toBe('https://www.figma.com/design/abcDEF123?node-id=1-2')
    const md = renderDesignContext(ctx)
    expect(md).toContain('## Login Card (320×200)')
    expect(md).toContain('### Layout')
    expect(md).toContain('- Title _TEXT_')
    expect(md).toContain('### Text content')
    expect(md).toContain('- Sign in')
    expect(md).toContain('- Continue')
    expect(md).toContain('### Components')
    expect(md).toContain('- Button/Primary')
  })

  it('omits empty sections', () => {
    const ctx = buildFigmaDesignContext({
      externalId: 'Key',
      fileName: 'File',
      roots: [{ name: 'Empty', type: 'FRAME' }],
      components: {},
    })
    expect(renderDesignContext(ctx)).toBe('## Empty')
  })

  it('surfaces a rendered-preview URL as a reference line', () => {
    const ctx = buildFigmaDesignContext({
      externalId: 'Key:1:2',
      fileName: 'File',
      nodeId: '1:2',
      roots: [{ name: 'F', type: 'FRAME' }],
      components: {},
      previewUrl: 'https://api.figma.com/preview.png',
    })
    expect(renderDesignContext(ctx)).toContain('### References')
    expect(renderDesignContext(ctx)).toContain(
      '- Rendered preview: https://api.figma.com/preview.png',
    )
  })
})

describe('figmaTokens', () => {
  it('maps collection › mode › name = value, including colour hex', () => {
    const tokens = figmaTokens({
      variables: {
        v1: {
          name: 'color/primary',
          variableCollectionId: 'c1',
          valuesByMode: { m1: { r: 1, g: 0, b: 0, a: 1 } },
        },
        v2: {
          name: 'space/sm',
          variableCollectionId: 'c1',
          valuesByMode: { m1: 8 },
        },
      },
      variableCollections: {
        c1: { name: 'Core', modes: [{ modeId: 'm1', name: 'Light' }] },
      },
    })
    const md = renderDesignContext({
      title: 't',
      url: 'u',
      blocks: [],
      components: [],
      tokens,
      references: [],
    })
    expect(md).toContain('### Design tokens')
    expect(md).toContain('- Core › Light › color/primary = #ff0000')
    expect(md).toContain('- Core › Light › space/sm = 8')
  })

  it('returns no tokens when there are no variables (renderer drops the section)', () => {
    expect(figmaTokens(undefined)).toEqual([])
    expect(figmaTokens({ variables: {} })).toEqual([])
  })
})
