import { describe, expect, it } from 'vitest'
import { renderDesignContext } from './design.logic.js'
import {
  MAX_FILE_FRAMES,
  assertSafeFigmaUrl,
  buildFigmaDesignContext,
  figmaBlocks,
  figmaComponents,
  figmaDroppedNodeId,
  figmaPageSummary,
  figmaStyleTokens,
  figmaStylingFacts,
  figmaTokenOrigin,
  figmaTokens,
  figmaTopLevelFrames,
  figmaUrlFor,
  normalizeFigmaNodeId,
  parseFigmaRef,
  splitFigmaExternalId,
  type FigmaComponentMap,
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

describe('figmaDroppedNodeId', () => {
  // `parseFigmaRef` falling back to the whole file is right (nothing knows which frame a complex
  // instance id meant), but it turns "this frame" into "the entire design" with nothing in the
  // resolved id to show it. This is the only thing that can say so, so the pre-flight can.
  it('names the unreadable node qualifier the ref fell back from, as pasted', () => {
    const url = 'https://www.figma.com/design/K/Title?node-id=I2649:14930;2649:14746'
    expect(figmaDroppedNodeId(url, parseFigmaRef(url)!)).toBe('I2649:14930;2649:14746')
    // The dash form Figma's share button emits, and the bare `key:node` form, both count.
    const dashed = 'https://www.figma.com/design/K/Title?node-id=I12-3;45-6'
    expect(figmaDroppedNodeId(dashed, parseFigmaRef(dashed)!)).toBe('I12-3;45-6')
    expect(figmaDroppedNodeId('K:I12:3;45:6', 'K')).toBe('I12:3;45:6')
  })

  it('reports nothing when the frame survived, or when no frame was named', () => {
    // A whole-file link is what the person asked for, and must not be flagged as a loss: an
    // over-eager warning here would train people to ignore the one that matters.
    const withNode = 'https://www.figma.com/design/K/Title?node-id=1234-5678&t=xy'
    expect(figmaDroppedNodeId(withNode, parseFigmaRef(withNode)!)).toBeNull()
    const wholeFile = 'https://www.figma.com/design/K/Title'
    expect(figmaDroppedNodeId(wholeFile, parseFigmaRef(wholeFile)!)).toBeNull()
    expect(figmaDroppedNodeId('K', 'K')).toBeNull()
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

  it('leads with the coverage notes, which qualify everything under them', () => {
    const md = renderDesignContext(
      buildFigmaDesignContext({
        externalId: 'Key',
        fileName: 'File',
        roots: [frame],
        components: {},
        fetchNotes: ['4 of 40 frames were imported.'],
      }),
    )
    expect(md.startsWith('### Notes\n- 4 of 40 frames were imported.')).toBe(true)
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

describe('figmaStylingFacts', () => {
  it('reads the fill, typography, radius and auto-layout an implementer would guess at', () => {
    expect(
      figmaStylingFacts({
        fills: [{ type: 'SOLID', color: { r: 0.2, g: 0.4, b: 1 } }],
        strokes: [{ type: 'SOLID', color: { r: 0, g: 0, b: 0, a: 0.5 } }],
        style: { fontFamily: 'Inter', fontSize: 16, fontWeight: 600, lineHeightPx: 24 },
        cornerRadius: 8,
        layoutMode: 'VERTICAL',
        itemSpacing: 12,
        paddingTop: 16,
        paddingRight: 24,
        paddingBottom: 16,
        paddingLeft: 24,
      }),
    ).toEqual([
      'fill #3366ff',
      'stroke #000000 (a=0.50)',
      'Inter 16/600 lh 24',
      'radius 8',
      'auto-layout vertical gap 12 padding 16/24/16/24',
    ])
  })

  it('skips an invisible or non-solid paint rather than naming a colour it does not have', () => {
    expect(
      figmaStylingFacts({
        fills: [
          { type: 'SOLID', visible: false, color: { r: 1, g: 0, b: 0 } },
          { type: 'GRADIENT_LINEAR' },
          { type: 'SOLID', color: { r: 0, g: 1, b: 0 } },
        ],
      }),
    ).toEqual(['fill #00ff00'])
  })

  it('renders uniform padding once and drops a zero-padding auto-layout qualifier', () => {
    expect(
      figmaStylingFacts({
        layoutMode: 'HORIZONTAL',
        paddingTop: 8,
        paddingRight: 8,
        paddingBottom: 8,
        paddingLeft: 8,
      }),
    ).toEqual(['auto-layout horizontal padding 8'])
    expect(figmaStylingFacts({ layoutMode: 'NONE', cornerRadius: 0 })).toEqual([])
  })
})

describe('figmaBlocks caps', () => {
  /** A chain `depth` levels deep, so the depth cap is what stops the walk. */
  function chain(depth: number): FigmaNode {
    let node: FigmaNode = { name: `leaf`, type: 'TEXT', characters: 'x' }
    for (let i = 0; i < depth; i++) node = { name: `n${i}`, type: 'FRAME', children: [node] }
    return node
  }

  it('marks a frame the depth cap cut, and names the cap in a note', () => {
    const { blocks, notes } = figmaBlocks([{ name: 'Deep', type: 'FRAME', children: [chain(9)] }])
    expect(blocks[0]!.sections[0]!.lines.some((l) => l.includes('deeper'))).toBe(true)
    expect(notes).toHaveLength(1)
    expect(notes[0]).toContain('1 of 1 frames a branch continues past that')
  })

  it('keeps the SIBLINGS of a branch the depth cap cut', () => {
    // The depth cap is LOCAL to a branch: conflating it with budget exhaustion made one deep
    // first child drop every later sibling of every ancestor, which for a real frame (auto-layout
    // nests past 6 levels routinely) reduced the layout to its first branch.
    const { blocks, notes } = figmaBlocks([
      {
        name: 'Screen',
        type: 'FRAME',
        children: [
          { name: 'DeepBranch', type: 'FRAME', children: [chain(9)] },
          { name: 'SiblingTwo', type: 'FRAME', children: [{ name: 'b', type: 'TEXT' }] },
          { name: 'SiblingThree', type: 'FRAME' },
        ],
      },
    ])
    const layout = blocks[0]!.sections[0]!.lines.join('\n')
    expect(layout).toContain('SiblingTwo')
    expect(layout).toContain('SiblingThree')
    // The cut is still STATED, at the branch that was cut, and exactly once.
    expect(layout.match(/deeper node/g)).toHaveLength(1)
    expect(notes[0]).toContain('a branch continues past that')
  })

  it('names how many nodes a depth cut left below, so a cut cannot read as a leaf', () => {
    const { blocks } = figmaBlocks([
      {
        name: 'Deep',
        type: 'FRAME',
        children: [
          (() => {
            let node: FigmaNode = {
              name: 'atCap',
              type: 'FRAME',
              children: [
                { name: 'x', type: 'TEXT' },
                { name: 'y', type: 'TEXT' },
                { name: 'z', type: 'TEXT' },
              ],
            }
            for (let i = 0; i < 6; i++) node = { name: `n${i}`, type: 'FRAME', children: [node] }
            return node
          })(),
        ],
      },
    ])
    expect(blocks[0]!.sections[0]!.lines.join('\n')).toContain('(3 deeper nodes not shown)')
  })

  it('says nothing when nothing was dropped', () => {
    const { notes } = figmaBlocks([
      { name: 'Shallow', type: 'FRAME', children: [{ name: 'a', type: 'TEXT', characters: 'a' }] },
    ])
    expect(notes).toEqual([])
  })

  it('bounds the WHOLE import, not each frame: one wide frame cannot spend the budget alone', () => {
    // 40 frames of 100 children each is 4,000 nodes; the import budget is what stops it, and
    // a per-frame cap alone would let a whole-file import produce all of them.
    const wide = (name: string): FigmaNode => ({
      name,
      type: 'FRAME',
      children: Array.from({ length: 100 }, (_, i) => ({ name: `c${i}`, type: 'RECTANGLE' })),
    })
    const { blocks, notes } = figmaBlocks(Array.from({ length: 40 }, (_, i) => wide(`F${i}`)))
    const rendered = blocks.reduce((n, b) => n + b.sections[0]!.lines.length, 0)
    expect(rendered).toBeLessThan(2000)
    expect(notes.join('\n')).toContain('import-wide budget of 1500 layout nodes')
  })

  it('leaves ONE truncation marker where the budget ran out, not one per unwinding ancestor', () => {
    // A marker per ancestor is noise the model has to read past, and it misreports one cut as
    // a dozen. The exhaustion guard owns the marker, so ancestors add nothing as they unwind.
    const deepWide: FigmaNode = {
      name: 'Frame',
      type: 'FRAME',
      children: [chain(5)],
    }
    const many = Array.from({ length: 60 }, () => deepWide)
    const { blocks } = figmaBlocks(many)
    const markers = blocks
      .flatMap((b) => b.sections[0]!.lines)
      .filter((l) => l.includes('(truncated)')).length
    // One frame is where the budget runs out; every frame after it renders nothing at all.
    expect(markers).toBeLessThanOrEqual(1)
  })

  it('STATES a text cap instead of letting the dropped text read as a frame with none', () => {
    // The renderer drops an empty section, so a frame whose text the import budget refused was
    // byte-for-byte a frame that contains no text. That is the silence this whole model exists
    // to break, and the layout notes said nothing about text.
    const texty = (name: string): FigmaNode => ({
      name,
      type: 'FRAME',
      children: Array.from({ length: 80 }, (_, i) => ({
        name: `t${i}`,
        type: 'TEXT',
        characters: `line ${i}`,
      })),
    })
    const { blocks, notes } = figmaBlocks(Array.from({ length: 12 }, (_, i) => texty(`F${i}`)))
    const last = blocks[11]!.sections[1]!.lines
    expect(last).not.toEqual([])
    expect(last.at(-1)).toContain('(text truncated)')
    expect(notes.join('\n')).toContain('import-wide budget of 600 text lines')
  })

  it('distinguishes the per-frame text cap from the import-wide one', () => {
    const { notes } = figmaBlocks([
      {
        name: 'Wordy',
        type: 'FRAME',
        children: Array.from({ length: 250 }, (_, i) => ({
          name: `t${i}`,
          type: 'TEXT',
          characters: `line ${i}`,
        })),
      },
    ])
    expect(notes.join('\n')).toContain('capped at 200 lines per frame')
    expect(notes.join('\n')).not.toContain('import-wide budget of 600 text lines')
  })
})

describe('figmaTopLevelFrames', () => {
  it("flattens every page's frame children and skips what is not a frame", () => {
    const frames = figmaTopLevelFrames({
      name: 'Document',
      children: [
        {
          name: 'Page 1',
          children: [
            { id: '1:1', name: 'Home', type: 'FRAME' },
            { id: '1:2', name: 'a sticky', type: 'STICKY' },
            { name: 'no id', type: 'FRAME' },
          ],
        },
        { name: 'Page 2', children: [{ id: '2:1', name: 'Settings', type: 'COMPONENT' }] },
      ],
    })
    expect(frames.map((f) => f.id)).toEqual(['1:1', '2:1'])
    expect(MAX_FILE_FRAMES).toBeGreaterThan(0)
  })

  it('returns nothing for an empty document', () => {
    expect(figmaTopLevelFrames(undefined)).toEqual([])
    expect(figmaTopLevelFrames({ name: 'Document' })).toEqual([])
  })
})

describe('figmaComponents', () => {
  const button = (variant: string, props?: FigmaNode['componentProperties']): FigmaNode => ({
    name: 'Button instance',
    type: 'INSTANCE',
    componentId: variant,
    componentProperties: props,
  })

  it('names a variant by its SET and folds every observed variant onto one note', () => {
    const components = figmaComponents(
      [
        {
          name: 'Frame',
          type: 'FRAME',
          children: [
            button('c1', { 'Size#1:0': { value: 'Large', type: 'VARIANT' } }),
            button('c2', {
              'Size#1:0': { value: 'Small', type: 'VARIANT' },
              'Label#2:0': { value: 'Continue', type: 'TEXT' },
              'Icon#3:0': { value: true, type: 'BOOLEAN' },
            }),
          ],
        },
      ],
      {
        c1: { name: 'Size=Large', componentSetId: 'set1', description: 'The primary action.' },
        c2: { name: 'Size=Small', componentSetId: 'set1' },
      },
      { set1: { name: 'Button' } },
    )
    expect(components).toEqual([
      {
        name: 'Button',
        note: 'variants: Size=Large | Size=Small; props: Icon=true, Label; The primary action.',
      },
    ])
  })

  it('falls back to the component name when there is no set, and reports no variant', () => {
    const components = figmaComponents([{ name: 'F', type: 'FRAME', children: [button('c9')] }], {
      c9: { name: 'Avatar' },
    })
    expect(components).toEqual([{ name: 'Avatar', note: undefined }])
  })
})

describe('component + token caps (they grow with the design SYSTEM, not the frames)', () => {
  /** `count` distinct instances, each of a differently-named component. */
  function instances(count: number, repeatFirst = 0): FigmaNode {
    const children: FigmaNode[] = []
    for (let i = 0; i < count; i++) children.push({ type: 'INSTANCE', componentId: `c${i}` })
    for (let i = 0; i < repeatFirst; i++) children.push({ type: 'INSTANCE', componentId: 'c0' })
    return { name: 'Frame', type: 'FRAME', children }
  }

  function componentMap(count: number): FigmaComponentMap {
    return Object.fromEntries(
      Array.from({ length: count }, (_, i) => [
        `c${i}`,
        { name: `Comp${String(i).padStart(3, '0')}` },
      ]),
    )
  }

  it('caps the components list and STATES what it dropped', () => {
    const ctx = buildFigmaDesignContext({
      externalId: 'Key',
      fileName: 'Library',
      roots: [instances(180)],
      components: componentMap(180),
    })
    expect(ctx.components).toHaveLength(150)
    expect(ctx.notes?.join('\n')).toContain('30 of 180 components are not listed')
  })

  it('keeps the components the design leans on: the cap ranks by instance count', () => {
    // The cap has to drop SOMETHING; dropping the most-used component would be the one
    // outcome that makes "reuse the existing component" useless.
    const heavy = 'Comp179'
    const roots = [instances(180, 40)]
    const map = componentMap(180)
    map.c0 = { name: heavy }
    const ctx = buildFigmaDesignContext({
      externalId: 'Key',
      fileName: 'Library',
      roots,
      components: map,
    })
    expect(ctx.components.map((c) => c.name)).toContain(heavy)
  })

  it('caps tokens as a PREFIX of the order they render in, and states the drop', () => {
    const variables = Object.fromEntries(
      Array.from({ length: 300 }, (_, i) => [
        `v${i}`,
        {
          name: `color/${String(i).padStart(3, '0')}`,
          variableCollectionId: 'c1',
          valuesByMode: { m1: i },
        },
      ]),
    )
    const ctx = buildFigmaDesignContext({
      externalId: 'Key',
      fileName: 'F',
      roots: [{ name: 'F', type: 'FRAME' }],
      components: {},
      variablesMeta: { variables, variableCollections: { c1: { name: 'Core', modes: [] } } },
    })
    expect(ctx.tokens).toHaveLength(250)
    expect(ctx.notes?.join('\n')).toContain('50 of 300 design tokens are not listed')
    // A prefix of the RENDERED order: the reader can trust that the tail is what is missing.
    const md = renderDesignContext(ctx)
    expect(md).toContain('color/000')
    expect(md).toContain('color/249')
    expect(md).not.toContain('color/250')
  })

  it('says nothing about either cap when neither bit', () => {
    const ctx = buildFigmaDesignContext({
      externalId: 'Key',
      fileName: 'F',
      roots: [instances(3)],
      components: componentMap(3),
    })
    expect(ctx.notes?.join('\n') ?? '').not.toContain('not listed')
  })
})

describe('figmaPageSummary', () => {
  it('counts the importable frames each page contributes, naming an unnamed page by index', () => {
    expect(
      figmaPageSummary({
        name: 'Document',
        children: [
          {
            name: 'Marketing',
            children: [
              { id: '1:1', type: 'FRAME' },
              { id: '1:2', type: 'STICKY' },
            ],
          },
          { children: [{ id: '2:1', type: 'COMPONENT' }] },
          // A page with nothing importable is not worth a row.
          { name: 'Scratch', children: [{ id: '3:1', type: 'STICKY' }] },
        ],
      }),
    ).toEqual([
      { name: 'Marketing', frames: 1 },
      { name: 'Page 2', frames: 1 },
    ])
  })
})

describe('figmaStyleTokens (the plan-independent token source)', () => {
  const root: FigmaNode = {
    name: 'Frame',
    type: 'FRAME',
    children: [
      {
        name: 'Heading',
        type: 'TEXT',
        styles: { fill: 'S1', text: 'S2', effect: 'S3' },
        fills: [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 } }],
        style: { fontFamily: 'Inter', fontSize: 32 },
      },
      // A second reference to the same style must not duplicate the token.
      {
        name: 'Sub',
        type: 'TEXT',
        styles: { fill: 'S1' },
        fills: [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 } }],
      },
    ],
  }

  it('joins the published-style names to the values the nodes carry', () => {
    expect(
      figmaStyleTokens([root], {
        S1: { name: 'surface/base', styleType: 'FILL' },
        S2: { name: 'text/display', styleType: 'TEXT' },
        S3: { name: 'shadow/lg', styleType: 'EFFECT' },
      }),
    ).toEqual([
      { collection: 'Colors', name: 'surface/base', value: '#ffffff' },
      { collection: 'Typography', name: 'text/display', value: 'Inter 32px' },
    ])
  })

  it('drops a style whose value it cannot resolve rather than emitting a bare name', () => {
    expect(
      figmaStyleTokens([{ name: 'F', styles: { fill: 'S1' } }], { S1: { name: 'x' } }),
    ).toEqual([])
  })
})

describe('figmaTokenOrigin', () => {
  it('names variables when they produced the section', () => {
    expect(figmaTokenOrigin({ status: 'ok', variableTokens: 3, styleTokens: 9 })).toEqual({
      label: 'Figma variables',
    })
  })

  it('distinguishes a plan gate from a failed read when styles carried the section', () => {
    expect(figmaTokenOrigin({ status: 'gated', variableTokens: 0, styleTokens: 2 })).toEqual({
      label: 'published styles',
      note: 'Variable-defined tokens are absent: the Figma variables API is not available on this plan.',
    })
    expect(
      figmaTokenOrigin({ status: 'failed', variableTokens: 0, styleTokens: 2 })?.note,
    ).toContain('variables read failed')
  })

  it('states the gate even with nothing to render, and stays silent on a genuine absence', () => {
    expect(
      figmaTokenOrigin({ status: 'gated', variableTokens: 0, styleTokens: 0 })?.label,
    ).toBeUndefined()
    expect(
      figmaTokenOrigin({ status: 'gated', variableTokens: 0, styleTokens: 0 })?.note,
    ).toContain('No design tokens')
    // Nothing was refused and nothing was found: a design that defines no tokens says nothing.
    expect(figmaTokenOrigin({ status: 'ok', variableTokens: 0, styleTokens: 0 })).toBeUndefined()
  })
})
