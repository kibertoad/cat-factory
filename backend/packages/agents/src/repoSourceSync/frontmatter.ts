// Shared YAML-frontmatter parsing for repo-sourced content (prompt fragments and
// Claude skills). Both consume a Markdown file whose leading `--- … ---` block is a
// deliberately small YAML subset — top-level `key: value`, inline `[a, b]` arrays,
// and one level of nested map (fragments' `appliesTo`). No I/O, so unit-testable.

/** Split a `--- … ---` frontmatter block off the front of a Markdown file. */
export function splitFrontmatter(content: string): { frontmatter: string; body: string } {
  // Tolerate a leading BOM/whitespace before the opening fence.
  const match = content.match(/^﻿?\s*---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
  if (!match) return { frontmatter: '', body: content }
  return { frontmatter: match[1] ?? '', body: match[2] ?? '' }
}

/** A deliberately small YAML subset: top-level `key: value` and one nested map. */
export function parseSimpleYaml(text: string): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  const lines = text.split(/\r?\n/)
  let nested: Record<string, unknown> | null = null
  for (const raw of lines) {
    if (!raw.trim() || raw.trim().startsWith('#')) continue
    const indented = /^\s+/.test(raw)
    const colon = raw.indexOf(':')
    if (colon === -1) continue
    const key = raw.slice(0, colon).trim()
    const value = raw.slice(colon + 1).trim()
    if (indented && nested) {
      nested[key] = parseScalarOrArray(value)
      continue
    }
    if (value === '') {
      // Opens a nested map (e.g. `appliesTo:`).
      nested = {}
      out[key] = nested
    } else {
      nested = null
      out[key] = parseScalarOrArray(value)
    }
  }
  return out
}

function parseScalarOrArray(value: string): unknown {
  const inline = value.match(/^\[(.*)\]$/)
  if (inline) {
    return inline[1]!
      .split(',')
      .map((s) => unquote(s.trim()))
      .filter((s) => s.length > 0)
  }
  return unquote(value)
}

function unquote(s: string): string {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1)
  }
  return s
}

/** A trimmed non-empty string, or undefined. */
export function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/** Coerce a scalar-or-array frontmatter value into a trimmed string array. */
export function strArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean)
  const single = str(value)
  return single ? [single] : []
}
