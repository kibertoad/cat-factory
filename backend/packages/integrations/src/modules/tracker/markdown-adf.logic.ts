// Markdown to Atlassian Document Format (ADF), the body shape Jira Cloud's REST v3 takes for an
// issue description and a comment. The inverse of `tasks/jira.logic.ts`'s `adfToMarkdown`.
//
// It covers the Markdown the platform itself writes onto a tracker: headings, paragraphs, nested
// bullet and ordered lists, fenced code, block quotes, rules, and the inline `code`, strong,
// emphasis and link marks. Anything else (a table, raw HTML) is carried through as paragraph text,
// so content is never dropped, only left unformatted.
//
// Two rules make the output safe to send as well as faithful:
//
//  - ADF text is inert. `kernel/hostMarkdown` defuses a mention or an issue reference by writing
//    its first character as a numeric entity, which a Markdown host renders as the character. ADF
//    would show the entity itself, so numeric entities are decoded back here: an ADF text node
//    carrying `@alice` or `#42` links to nothing, because mentions are their own node type.
//  - Only an `http(s)` target becomes a link mark. Any other target keeps its label as text.

interface AdfMark {
  type: 'strong' | 'em' | 'code' | 'link'
  attrs?: Record<string, unknown>
}
interface AdfText {
  type: 'text'
  text: string
  marks?: AdfMark[]
}
interface AdfNode {
  type: string
  content?: (AdfNode | AdfText)[]
  attrs?: Record<string, unknown>
}
export interface AdfDoc {
  type: 'doc'
  version: 1
  content: AdfNode[]
}

/** Convert Markdown into an ADF document. An empty body yields one empty paragraph. */
export function markdownToAdf(markdown: string): AdfDoc {
  const lines = markdown.replace(/\r\n?/g, '\n').replace(/\t/g, '    ').split('\n')
  const content = parseBlocks(lines)
  if (content.length === 0) content.push({ type: 'paragraph', content: [] })
  return { type: 'doc', version: 1, content }
}

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([^`\s]*)/
const HEADING = /^ {0,3}(#{1,6})\s+(.*?)(?:\s+#+\s*)?$/
const RULE = /^ {0,3}(?:(?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,})$/
const QUOTE = /^ {0,3}>\s?(.*)$/
const LIST_ITEM = /^( *)([-*+]|\d{1,9}[.)])\s+(.*)$/

const indentOf = (line: string): number => line.length - line.trimStart().length
const isBlank = (line: string): boolean => line.trim() === ''

/** Whether a line starts a block other than a paragraph, which ends the paragraph before it. */
function startsBlock(line: string): boolean {
  return (
    FENCE.test(line) ||
    HEADING.test(line) ||
    RULE.test(line) ||
    QUOTE.test(line) ||
    LIST_ITEM.test(line)
  )
}

function parseBlocks(lines: readonly string[]): AdfNode[] {
  const out: AdfNode[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]!
    if (isBlank(line)) {
      i += 1
      continue
    }
    const fence = FENCE.exec(line)
    if (fence) {
      const marker = fence[1]!
      const body: string[] = []
      i += 1
      while (i < lines.length && !lines[i]!.trimStart().startsWith(marker)) body.push(lines[i++]!)
      i += 1
      const text = body.join('\n')
      out.push({
        type: 'codeBlock',
        ...(fence[2] ? { attrs: { language: fence[2] } } : {}),
        content: text ? [{ type: 'text', text }] : [],
      })
      continue
    }
    const heading = HEADING.exec(line)
    if (heading) {
      out.push({
        type: 'heading',
        attrs: { level: heading[1]!.length },
        content: parseInline(heading[2]!.trim()),
      })
      i += 1
      continue
    }
    // Checked before the list item: `---` and `* * *` would otherwise read as list markers.
    if (RULE.test(line)) {
      out.push({ type: 'rule' })
      i += 1
      continue
    }
    if (QUOTE.test(line)) {
      const inner: string[] = []
      while (i < lines.length && QUOTE.test(lines[i]!)) inner.push(QUOTE.exec(lines[i++]!)![1]!)
      out.push({ type: 'blockquote', content: quoteContent(parseBlocks(inner)) })
      continue
    }
    if (LIST_ITEM.test(line)) {
      const list = parseList(lines, i)
      out.push(list.node)
      i = list.next
      continue
    }
    const paragraph: string[] = []
    while (
      i < lines.length &&
      !isBlank(lines[i]!) &&
      (paragraph.length === 0 || !startsBlock(lines[i]!))
    ) {
      paragraph.push(lines[i++]!.trim())
    }
    out.push({ type: 'paragraph', content: joinLines(paragraph) })
  }
  return out
}

/**
 * One list starting at `start`: its siblings share the first item's indent and marker kind. An
 * item owns every following line indented past that indent (continuation text, a nested list),
 * and a blank line ends the list unless the next line still belongs to it.
 */
function parseList(lines: readonly string[], start: number): { node: AdfNode; next: number } {
  const first = LIST_ITEM.exec(lines[start]!)!
  const indent = first[1]!.length
  const ordered = /\d/.test(first[2]!)
  const items: AdfNode[] = []
  let i = start
  while (i < lines.length) {
    const match = LIST_ITEM.exec(lines[i]!)
    if (!match || match[1]!.length !== indent || /\d/.test(match[2]!) !== ordered) break
    const body = [match[3]!]
    i += 1
    while (i < lines.length) {
      const line = lines[i]!
      if (isBlank(line)) {
        const following = lines[i + 1]
        if (following === undefined || isBlank(following) || indentOf(following) <= indent) break
        body.push('')
        i += 1
        continue
      }
      if (indentOf(line) <= indent) break
      body.push(line)
      i += 1
    }
    items.push({ type: 'listItem', content: listItemContent(parseBlocks(dedent(body))) })
    if (i < lines.length && isBlank(lines[i]!)) {
      const following = lines[i + 1]
      const sibling = following === undefined ? null : LIST_ITEM.exec(following)
      if (!sibling || sibling[1]!.length !== indent) break
      i += 1
    }
  }
  const order = Number.parseInt(first[2]!, 10)
  return {
    node: ordered
      ? {
          type: 'orderedList',
          attrs: { order: Number.isFinite(order) ? order : 1 },
          content: items,
        }
      : { type: 'bulletList', content: items },
    next: i,
  }
}

/** Strip the common indent of an item's continuation lines; its first line is already bare. */
function dedent(body: readonly string[]): string[] {
  const rest = body.slice(1).filter((line) => !isBlank(line))
  const cut = rest.length > 0 ? Math.min(...rest.map(indentOf)) : 0
  return [body[0]!, ...body.slice(1).map((line) => line.slice(Math.min(cut, indentOf(line))))]
}

/**
 * ADF lets a list item hold paragraphs, code blocks and nested lists, and requires it to OPEN with
 * a paragraph or code block. A heading or quote inside an item is folded to its paragraphs.
 */
function listItemContent(blocks: AdfNode[]): AdfNode[] {
  const out: AdfNode[] = []
  for (const block of blocks) {
    if (block.type === 'heading') out.push({ type: 'paragraph', content: block.content ?? [] })
    else if (block.type === 'blockquote') out.push(...listItemContent(block.content as AdfNode[]))
    else if (block.type !== 'rule') out.push(block)
  }
  const head = out[0]?.type
  if (head !== 'paragraph' && head !== 'codeBlock') out.unshift({ type: 'paragraph', content: [] })
  return out
}

/** ADF quotes hold paragraphs, lists and code blocks; a heading is folded to its paragraph. */
function quoteContent(blocks: AdfNode[]): AdfNode[] {
  const out = blocks
    .filter((block) => block.type !== 'rule' && block.type !== 'blockquote')
    .map((block) =>
      block.type === 'heading' ? { type: 'paragraph', content: block.content ?? [] } : block,
    )
  return out.length > 0 ? out : [{ type: 'paragraph', content: [] }]
}

/** A paragraph's lines, kept apart by hard breaks: GitHub and GitLab comments show them so too. */
function joinLines(lines: readonly string[]): (AdfNode | AdfText)[] {
  const out: (AdfNode | AdfText)[] = []
  lines.forEach((line, index) => {
    if (index > 0) out.push({ type: 'hardBreak' })
    out.push(...parseInline(line))
  })
  return out
}

const SAFE_LINK = /^https?:\/\/[^\s()<>]+$/i

/** Parse one line of inline Markdown into marked text nodes. */
function parseInline(text: string, marks: readonly AdfMark[] = []): AdfText[] {
  const out: AdfText[] = []
  let plain = ''
  const flush = () => {
    if (plain) out.push(textNode(decodeEntities(plain), marks))
    plain = ''
  }
  let i = 0
  while (i < text.length) {
    const ch = text[i]!
    if (ch === '\\' && i + 1 < text.length && /[\\`*_[\]()#+\-.!>~|]/.test(text[i + 1]!)) {
      plain += text[i + 1]
      i += 2
      continue
    }
    if (ch === '`') {
      const run = /^`+/.exec(text.slice(i))![0]
      const close = text.indexOf(run, i + run.length)
      if (close > i) {
        flush()
        const code = text.slice(i + run.length, close).replace(/^ (.*) $/, '$1')
        if (code)
          out.push(textNode(code, [...marks.filter((m) => m.type === 'link'), { type: 'code' }]))
        i = close + run.length
        continue
      }
    }
    if (ch === '[') {
      const link = /^\[([^\]]+)\]\(([^)\s]+)\)/.exec(text.slice(i))
      if (link) {
        flush()
        const href = link[2]!
        const inner = SAFE_LINK.test(href)
          ? [...marks, { type: 'link' as const, attrs: { href } }]
          : marks
        out.push(...parseInline(link[1]!, inner))
        i += link[0].length
        continue
      }
    }
    if (ch === '*' || ch === '_') {
      const span = emphasisAt(text, i)
      if (span) {
        flush()
        out.push(...parseInline(span.inner, [...marks, { type: span.mark }]))
        i = span.end
        continue
      }
    }
    plain += ch
    i += 1
  }
  flush()
  return mergeAdjacent(out)
}

/** A `**strong**` / `*em*` (or underscore) span opening at `i`, or null when none closes. */
function emphasisAt(
  text: string,
  i: number,
): { mark: 'strong' | 'em'; inner: string; end: number } | null {
  const ch = text[i]!
  const double = text[i + 1] === ch
  const delim = double ? ch + ch : ch
  const from = i + delim.length
  if (!text[from] || /\s/.test(text[from]!)) return null
  // Underscores inside a word (`snake_case_name`) are not emphasis.
  if (ch === '_' && i > 0 && /\w/.test(text[i - 1]!)) return null
  let close = text.indexOf(delim, from + 1)
  while (close !== -1) {
    const before = text[close - 1]!
    const after = text[close + delim.length]
    const doubled = !double && after === ch
    const wordAfter = ch === '_' && after !== undefined && /\w/.test(after)
    if (!/\s/.test(before) && !doubled && !wordAfter) {
      return {
        mark: double ? 'strong' : 'em',
        inner: text.slice(from, close),
        end: close + delim.length,
      }
    }
    close = text.indexOf(delim, close + (doubled ? 2 : 1))
  }
  return null
}

function textNode(text: string, marks: readonly AdfMark[]): AdfText {
  return marks.length > 0 ? { type: 'text', text, marks: [...marks] } : { type: 'text', text }
}

function decodeEntities(text: string): string {
  return text.replace(/&#(x[0-9a-f]+|\d+);/gi, (entity, code: string) => {
    const point = code[0] === 'x' || code[0] === 'X' ? parseInt(code.slice(1), 16) : Number(code)
    return point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : entity
  })
}

/** Fold neighbouring text nodes carrying the same marks into one. */
function mergeAdjacent(nodes: AdfText[]): AdfText[] {
  const out: AdfText[] = []
  for (const node of nodes) {
    const last = out[out.length - 1]
    if (last && JSON.stringify(last.marks ?? []) === JSON.stringify(node.marks ?? [])) {
      out[out.length - 1] = { ...last, text: last.text + node.text }
    } else {
      out.push(node)
    }
  }
  return out
}
