// Turn an agent's prose output (markdown) into a heading-delimited outline so it
// can be read in the dedicated reader overlay: a navigable table of contents on
// one side, collapsible sections on the other.
//
// Markdown → HTML is done by `markdown-it` (a mature CommonMark parser) with
// `html: false`, so it is secure by default: any raw HTML in the agent's output
// is escaped rather than injected, and its `validateLink` blocks dangerous URL
// schemes — no separate sanitizer needed for the LLM-generated text we feed it.
// This module only adds the one thing markdown-it doesn't: SEGMENTATION — split
// the rendered document at each heading into sections we can collapse
// independently and link from a ToC. That split is done over the parsed DOM, so
// it is independent of markdown-it's token internals.
import MarkdownIt from 'markdown-it'

/**
 * Stamp every TOP-LEVEL block element with its source line range
 * (`data-src-start`/`data-src-end`, 0-based, end-exclusive — straight from
 * markdown-it's `token.map`). The approval-mode reader uses these to let a human
 * comment on a specific block and quote that block's verbatim raw markdown back to
 * the agent on a "request changes" re-run. Only top-level blocks are tagged (depth
 * tracked over the flat token stream) so a comment targets a whole paragraph/list/
 * heading rather than a nested fragment.
 */
function sourceLinePlugin(md: MarkdownIt): void {
  md.core.ruler.push('source_lines', (state) => {
    let depth = 0
    for (const token of state.tokens) {
      const atTopLevel = depth === 0
      // Annotate a top-level block's opening token (nesting 1) or a self-contained
      // block token (nesting 0, e.g. fence/hr/code_block/html_block).
      if (atTopLevel && token.block && token.type !== 'inline' && token.map && token.nesting >= 0) {
        token.attrSet('data-src-start', String(token.map[0]))
        token.attrSet('data-src-end', String(token.map[1]))
      }
      if (token.nesting === 1) depth++
      else if (token.nesting === -1) depth--
    }
    return true
  })
}

/**
 * The verbatim raw-markdown source of a block, given the original output text and a
 * 0-based, end-exclusive line range (as captured from `data-src-start/end`).
 */
export function sliceSource(output: string, start: number, end: number): string {
  return (output ?? '').split('\n').slice(start, end).join('\n')
}

/** One heading-delimited section. `depth` 0 / empty `title` is the preamble that
 * precedes the first heading (rendered, but never shown in the ToC). */
export interface OutputSection {
  id: string
  depth: number
  /** Plain-text heading, for the ToC. */
  title: string
  /** Inline-rendered heading HTML (code/bold/… preserved), for the section header. */
  titleHtml: string
  /** HTML of everything under this heading up to the next one. */
  bodyHtml: string
}

export interface OutputOutline {
  sections: OutputSection[]
  /** True once there is at least one real heading worth a ToC entry. */
  hasToc: boolean
  /** Shallowest heading depth present, so the ToC can indent relative to it. */
  minDepth: number
}

const md = new MarkdownIt({
  html: false, // secure by default: escape raw HTML rather than render it
  linkify: true, // turn bare URLs into links
  breaks: true, // single newlines → <br>, matching how agents lay out prose
  typographer: true,
}).use(sourceLinePlugin)

const HEADINGS = new Set(['H1', 'H2', 'H3', 'H4', 'H5', 'H6'])
const LINK_CLASS = 'text-indigo-300 underline decoration-indigo-500/40 hover:text-indigo-200'

// A second markdown-it instance for INLINE prose rendering (a rationale, a synthesis,
// a summary) — the same secure config as `md` (html: false, so raw HTML is escaped and
// dangerous link schemes are blocked by `validateLink`), but without the segmentation
// plugin: these surfaces render one continuous document, not a ToC-navigable outline.
// Link attributes are set through a renderer rule (not DOM post-processing) so the
// function returns ready-to-inject HTML without depending on `document`.
const proseMd = new MarkdownIt({
  html: false, // secure by default: escape raw HTML rather than render it
  linkify: true, // turn bare URLs into links
  breaks: true, // single newlines → <br>, matching how agents lay out prose
  typographer: true,
})

// Make every rendered link open safely in a new tab and pick up the prose link style,
// mirroring `decorateLinks` but at the token level so no DOM is required.
const defaultLinkOpen =
  proseMd.renderer.rules.link_open ??
  ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options))
proseMd.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  const token = tokens[idx]!
  token.attrSet('target', '_blank')
  token.attrSet('rel', 'noopener noreferrer')
  token.attrSet('class', LINK_CLASS)
  return defaultLinkOpen(tokens, idx, options, env, self)
}

/**
 * Render an agent's prose (markdown) to safe HTML for inline display. Escapes raw HTML,
 * blocks dangerous link schemes, and decorates links to open safely in a new tab — the
 * same guarantees as the reader overlay, minus the heading segmentation. Empty/nullish
 * input renders to an empty string.
 */
export function renderMarkdown(text: string | null | undefined): string {
  const source = text ?? ''
  return source.trim() ? proseMd.render(source) : ''
}

function slugify(title: string, used: Set<string>): string {
  const base =
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'section'
  let slug = base
  let n = 2
  while (used.has(slug)) slug = `${base}-${n++}`
  used.add(slug)
  return slug
}

/** Make every link open safely in a new tab and pick up the reader's link style. */
function decorateLinks(root: HTMLElement): void {
  for (const a of Array.from(root.querySelectorAll('a'))) {
    a.setAttribute('target', '_blank')
    a.setAttribute('rel', 'noopener noreferrer')
    a.setAttribute('class', LINK_CLASS)
  }
}

/** Build the heading-based outline for an agent's prose output. */
export function parseOutputOutline(text: string): OutputOutline {
  const source = text ?? ''
  if (!source.trim()) return { sections: [], hasToc: false, minDepth: 1 }

  const html = md.render(source)

  // No DOM (SSR / non-browser): fall back to one un-segmented section. The reader
  // overlay is client-only, so this path is effectively dead outside any runtime
  // without `document`.
  if (typeof document === 'undefined') {
    return {
      sections: [{ id: 'overview', depth: 0, title: '', titleHtml: '', bodyHtml: html }],
      hasToc: false,
      minDepth: 1,
    }
  }

  const root = document.createElement('div')
  root.innerHTML = html
  decorateLinks(root)

  const used = new Set<string>()
  const sections: OutputSection[] = []
  let current: OutputSection | null = null
  let body: HTMLElement | null = null

  const flush = () => {
    if (current && body) current.bodyHtml = body.innerHTML.trim()
    if (current) sections.push(current)
  }

  for (const node of Array.from(root.childNodes)) {
    const el = node.nodeType === 1 ? (node as HTMLElement) : null
    if (el && HEADINGS.has(el.tagName)) {
      flush()
      const title = (el.textContent ?? '').trim()
      current = {
        id: slugify(title, used),
        depth: Number(el.tagName[1]),
        title,
        titleHtml: el.innerHTML,
        bodyHtml: '',
      }
      body = document.createElement('div')
    } else {
      if (!current) {
        // Content before the first heading → untitled preamble section.
        current = {
          id: slugify('overview', used),
          depth: 0,
          title: '',
          titleHtml: '',
          bodyHtml: '',
        }
        body = document.createElement('div')
      }
      body!.appendChild(node.cloneNode(true))
    }
  }
  flush()

  // A preamble that turned out to hold nothing renderable is noise — drop it.
  const cleaned = sections.filter((s) => s.title || s.bodyHtml)
  const headed = cleaned.filter((s) => s.depth > 0)
  return {
    sections: cleaned,
    hasToc: headed.length > 0,
    minDepth: headed.length ? Math.min(...headed.map((s) => s.depth)) : 1,
  }
}
