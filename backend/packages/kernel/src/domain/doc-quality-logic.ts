// Pure structural analysis of a drafted Markdown document, shared by the `doc-quality`
// gate's provider and its unit tests. Lives in kernel (like `gate-logic.ts`) so the check
// is a deterministic, runtime-neutral reduction over the document text + the required
// section list — the gate's provider (in `@cat-factory/server`) resolves the section list
// from the WS1 template (`docTemplateFor`, the single source of truth) and the file bytes
// via the checkout-free `RepoFiles` port, then calls this to classify. No I/O here.

/** Inputs to {@link analyzeDocStructure}: the document body + the sections it must cover. */
export interface DocStructureInput {
  /** The document's Markdown content, as committed on the PR head. */
  content: string
  /**
   * The section titles the document is REQUIRED to cover, from the kind's template
   * (`requiredSectionTitles(docTemplateFor(kind))`). Matched leniently against the
   * document's headings (word-subset, case-insensitive) so a meaning-preserving rename
   * still counts — the outline is allowed to rename sections.
   */
  requiredSections: string[]
}

/** The structural problems found in a document (empty arrays ⇒ the document is well-formed). */
export interface DocStructureAnalysis {
  /** Required section titles with no matching heading in the document. */
  missingSections: string[]
  /** Leftover template / authoring placeholder markers found in the prose (skeleton not filled). */
  placeholders: string[]
  /** Heading-hierarchy problems: missing / duplicate top-level title, or a skipped level. */
  headingIssues: string[]
  /**
   * Repo-relative link targets the document references (http(s) / anchors / mailto excluded),
   * deduped in first-seen order. The gate's provider resolves each against the repo and reports
   * the ones that don't exist — link EXISTENCE needs file reads, so it lives with the provider,
   * not in this pure function.
   */
  relativeLinks: string[]
}

/** A parsed Markdown heading: its depth (`#`=1 … `######`=6) and text. */
export interface Heading {
  level: number
  text: string
}

/** Strip a leading YAML front-matter block (`--- … ---`) — it is config, not document prose. */
function stripFrontMatter(content: string): string {
  const m = content.match(/^﻿?---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/)
  return m ? content.slice(m[0].length) : content
}

/** Strip fenced code blocks (``` / ~~~) so their contents aren't parsed as headings/placeholders. */
function stripFencedCode(content: string): string {
  const lines = content.split(/\r?\n/)
  const out: string[] = []
  let fence: string | null = null
  for (const line of lines) {
    const open = line.match(/^\s*(`{3,}|~{3,})/)
    if (fence) {
      // Inside a fence: a matching (or longer) fence of the same char closes it.
      if (open && open[1]![0] === fence[0] && open[1]!.length >= fence.length) fence = null
      continue
    }
    if (open) {
      fence = open[1]!
      continue
    }
    out.push(line)
  }
  return out.join('\n')
}

/**
 * Blank out inline code spans (`` `<a href>` ``) and HTML comments so the placeholder + link
 * scans don't treat a code EXAMPLE as an unfilled skeleton or a broken link. Fenced blocks are
 * already gone by the time this runs; this covers the inline forms that survive them. Headings
 * are extracted from the pre-strip body, so a heading naming inline code is unaffected.
 */
function stripInlineCodeAndComments(content: string): string {
  return content
    .replace(/<!--[\s\S]*?-->/g, ' ') // HTML comments (may span lines)
    .replace(/(`+)[^`\n]*?\1/g, ' ') // inline code spans (matched backtick runs, single line)
}

/** ATX (`#`) heading, or its `#{1,6}` capture length; null for a non-heading line. */
function atxLevel(line: string): number | null {
  const m = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/)
  return m ? m[1]!.length : null
}

/** A setext underline (`===` ⇒ H1, `---` ⇒ H2) as a bare rule line, else null. */
function setextUnderline(line: string): string | null {
  const m = line.match(/^ {0,3}(=+|-+)[ \t]*$/)
  return m ? m[1]! : null
}

/** The ATX **and** setext headings in document order, from code-stripped content. */
function extractHeadings(content: string): Heading[] {
  const headings: Heading[] = []
  const lines = content.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    const m = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/)
    if (m) {
      headings.push({ level: m[1]!.length, text: m[2]!.trim() })
      continue
    }
    // Setext: a non-blank paragraph line underlined by `===` (H1) or `---` (H2). Guard the
    // usual confusions — a blank line before the rule makes it a thematic break, not a
    // heading, and an ATX / underline line above is never a setext title.
    const underline = setextUnderline(line)
    if (underline && i > 0) {
      const prev = lines[i - 1]!
      if (prev.trim() && atxLevel(prev) === null && setextUnderline(prev) === null) {
        headings.push({ level: underline[0] === '=' ? 1 : 2, text: prev.trim() })
      }
    }
  }
  return headings
}

/**
 * The ATX + setext headings of a Markdown document, front-matter and fenced code stripped first.
 * Public so a workspace-linked TEMPLATE document can be parsed into its section headings (WS1
 * item 3) with the SAME heading logic the gate uses — no second Markdown parser.
 */
export function documentHeadings(content: string): Heading[] {
  return extractHeadings(stripFencedCode(stripFrontMatter(content)))
}

/** The significant lowercase words of a heading/section title (emphasis + punctuation dropped). */
function significantWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/\(optional\)\s*$/i, '') // drop a leftover skeleton "(optional)" marker
    .replace(/[^a-z0-9]+/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 2)
}

/** Placeholder markers that signal an unfilled skeleton / draft (scanned outside code fences). */
const PLACEHOLDER_PATTERNS: { pattern: RegExp; label: string }[] = [
  { pattern: /\bTODO\b/, label: 'TODO' },
  { pattern: /\bTKTK\b/i, label: 'TKTK' },
  { pattern: /\bFIXME\b/, label: 'FIXME' },
  { pattern: /\bXXX\b/, label: 'XXX' },
  { pattern: /lorem ipsum/i, label: 'Lorem ipsum' },
  // An angle-bracket placeholder containing a space (`<Document title>`, `<your value>`) —
  // a real HTML tag / generic type argument almost never contains an inner space, so this
  // targets skeleton placeholders without flagging legitimate `<div>` / `<T>` in prose. The
  // inner class also forbids `= " ' /`, so a real attributed / self-closing HTML tag
  // (`<a href="x">`, `<img src="y">`, `<br />`) is NOT a placeholder — only prose-shaped
  // angle text is (inline-code examples are already stripped before this scan runs).
  { pattern: /<[A-Za-z][^<>\n="'/]*\s[^<>\n="'/]*>/, label: '<…> placeholder' },
]

/** Extract the repo-relative link/image targets (external URLs, anchors, mailto excluded). */
function extractRelativeLinks(content: string): string[] {
  const links = new Set<string>()
  const re = /!?\[[^\]]*\]\(\s*<?([^)\s>]+)>?[^)]*\)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(content)) !== null) {
    let target = m[1]!.trim()
    if (!target) continue
    // Drop an anchor / query on a relative path (`foo.md#section` → `foo.md`).
    target = target.split('#')[0]!.split('?')[0]!
    if (!target) continue // was a pure `#anchor`
    if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue // scheme (http:, mailto:, tel:, data:)
    if (target.startsWith('//')) continue // protocol-relative external
    links.add(target)
  }
  return [...links]
}

/**
 * Analyze a drafted document's structure against its required sections. Pure: same inputs →
 * same result. The gate's provider maps a non-empty analysis (plus any unresolved
 * {@link DocStructureAnalysis.relativeLinks}) to a `fail` verdict.
 */
export function analyzeDocStructure(input: DocStructureInput): DocStructureAnalysis {
  const body = stripFencedCode(stripFrontMatter(input.content))
  // Placeholder + link scans additionally ignore inline code / HTML comments, so a code
  // EXAMPLE (`` `<a href>` ``, `` `[x](./y.md)` ``, `// TODO`) can't be mistaken for a
  // leftover skeleton or a broken link. Headings still come from `body` (pre-inline-strip).
  const scanBody = stripInlineCodeAndComments(body)
  const headings = extractHeadings(body)
  const headingWordSets = headings.map((h) => new Set(significantWords(h.text)))

  const missingSections = input.requiredSections.filter((section) => {
    const words = significantWords(section)
    if (words.length === 0) return false
    return !headingWordSets.some((set) => words.every((w) => set.has(w)))
  })

  const placeholders: string[] = []
  for (const { pattern, label } of PLACEHOLDER_PATTERNS) {
    if (pattern.test(scanBody)) placeholders.push(label)
  }

  const headingIssues: string[] = []
  const h1Count = headings.filter((h) => h.level === 1).length
  if (h1Count === 0) headingIssues.push('The document has no top-level (`#`) title.')
  else if (h1Count > 1) {
    headingIssues.push(`The document has ${h1Count} top-level (\`#\`) titles; use exactly one.`)
  }
  // Level skips (e.g. an `#` followed by `###`), checked between consecutive headings so the
  // first heading is never itself flagged (the H1 rule above covers a missing title).
  let prevLevel = 0
  for (const h of headings) {
    if (prevLevel > 0 && h.level > prevLevel + 1) {
      headingIssues.push(
        `Heading "${h.text}" jumps from H${prevLevel} to H${h.level} (a heading level is skipped).`,
      )
    }
    prevLevel = h.level
  }

  return {
    missingSections,
    placeholders,
    headingIssues,
    relativeLinks: extractRelativeLinks(scanBody),
  }
}

/** Whether an analysis found any structural problem (before link-existence, which the provider adds). */
export function hasDocStructureIssues(analysis: DocStructureAnalysis): boolean {
  return (
    analysis.missingSections.length > 0 ||
    analysis.placeholders.length > 0 ||
    analysis.headingIssues.length > 0
  )
}

/**
 * Resolve a document-relative link target (from {@link DocStructureAnalysis.relativeLinks}) to a
 * repo-root-relative POSIX path — pure, no I/O. A leading-slash target is repo-root-relative;
 * anything else resolves against the document's own directory. Returns null when the link escapes
 * the repo root (a `../` that climbs past it) — such a link can't be a valid in-repo file, so the
 * caller (the gate's provider) skips it rather than reading a bogus path.
 */
export function resolveDocLinkPath(fromFile: string, link: string): string | null {
  const baseSegments = link.startsWith('/')
    ? [] // repo-root-relative
    : fromFile.split('/').slice(0, -1) // the document's directory
  const segments = [...baseSegments]
  for (const raw of link.replace(/^\/+/, '').split('/')) {
    if (raw === '' || raw === '.') continue
    if (raw === '..') {
      if (segments.length === 0) return null // escapes the repo root
      segments.pop()
      continue
    }
    segments.push(raw)
  }
  return segments.length > 0 ? segments.join('/') : null
}
