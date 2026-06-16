// Source-agnostic Markdown helpers shared by the integrations that normalize an
// external body to lightweight Markdown (document sources, task sources, …):
// collapsing the markers into plain text and deriving a short excerpt. Kept pure
// so they stay trivially testable and reusable across modules.

/** Strip lightweight Markdown markers into collapsed plain text. */
export function markdownToText(markdown: string): string {
  return markdown
    .replace(/`{1,3}/g, '')
    .replace(/^[ \t]*#{1,6}[ \t]+/gm, '')
    .replace(/^[ \t]*[-*+][ \t]+/gm, '')
    .replace(/[*_~>]/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
}

/** A short plain-text excerpt of a Markdown body, for list/preview rendering. */
export function buildExcerpt(markdown: string, max = 280): string {
  const text = markdownToText(markdown)
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text
}
