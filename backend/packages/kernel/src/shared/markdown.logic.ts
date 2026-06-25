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

/**
 * A rough token estimate for budgeting context. Not exact — it only trims context,
 * it never bills — so a model-agnostic heuristic beats a per-vendor tokenizer here
 * (our fleet spans Anthropic/Qwen/Llama, not just OpenAI). ~4 chars/token is the
 * conventional English approximation (Anthropic guides ~3.5; 4 keeps us from
 * over-trimming). Dependency-free so it runs on the Worker edge runtime.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

/**
 * A fast, dependency-free 32-bit FNV-1a hex digest. Used for cheap content-change
 * detection (skip re-importing an unchanged document body), NOT for security — so a
 * non-cryptographic hash is the right tool, and it runs identically on the Worker edge
 * runtime and Node without WebCrypto's async ceremony.
 */
export function contentHash(text: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, '0')
}
