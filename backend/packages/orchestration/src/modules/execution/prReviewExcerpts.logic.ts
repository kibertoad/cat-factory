import type { PrReviewFinding, PrReviewFindingExcerpt } from '@cat-factory/contracts'
import type { RepoFileContent } from '@cat-factory/kernel'

/** Lines of context taken on each side of a finding's anchor line. */
export const EXCERPT_CONTEXT_LINES = 3
/** Ceiling on one excerpt's UTF-8 size, so a minified or very wide file cannot balloon a decision. */
export const EXCERPT_MAX_BYTES = 2048
/** Distinct files read for one review; findings on files past it keep a null excerpt. */
export const EXCERPT_MAX_FILES = 40
const READ_CONCURRENCY = 8

/** Reads one repo file at the reviewed head; null when the path does not exist there. */
export type ReadReviewedFile = (path: string) => Promise<RepoFileContent | null>

const utf8 = new TextEncoder()

/**
 * The anchor line plus up to {@link EXCERPT_CONTEXT_LINES} either side, with context dropped from
 * the farther edge until the text fits {@link EXCERPT_MAX_BYTES}. Null when the line is outside the
 * file, the content is binary, or the anchor line alone is over budget.
 */
export function excerptAround(content: string, line: number): PrReviewFindingExcerpt | null {
  if (!Number.isInteger(line) || line < 1 || content.includes('\0')) return null
  const lines = content.split(/\r?\n/)
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()
  if (line > lines.length) return null

  let start = Math.max(1, line - EXCERPT_CONTEXT_LINES)
  let end = Math.min(lines.length, line + EXCERPT_CONTEXT_LINES)
  let text = lines.slice(start - 1, end).join('\n')
  while (utf8.encode(text).length > EXCERPT_MAX_BYTES) {
    if (start === line && end === line) return null
    if (start < line && line - start >= end - line) start++
    else end--
    text = lines.slice(start - 1, end).join('\n')
  }
  return { startLine: start, endLine: end, side: 'RIGHT', text }
}

function canExcerpt(finding: PrReviewFinding): finding is PrReviewFinding & { line: number } {
  // A LEFT anchor names a line of the base tree, which the reviewed head does not hold.
  return finding.line != null && finding.side !== 'LEFT' && finding.path !== ''
}

/**
 * Stamp each finding with its {@link excerptAround} excerpt, reading every distinct path once. A
 * read that fails, a deleted file and a lossy (non-UTF-8) file all leave the excerpt null.
 */
export async function attachFindingExcerpts(
  findings: PrReviewFinding[],
  readFile: ReadReviewedFile,
): Promise<PrReviewFinding[]> {
  const paths = [...new Set(findings.filter(canExcerpt).map((f) => f.path))].slice(
    0,
    EXCERPT_MAX_FILES,
  )
  const contents = new Map<string, string>()
  for (let i = 0; i < paths.length; i += READ_CONCURRENCY) {
    await Promise.all(
      paths.slice(i, i + READ_CONCURRENCY).map(async (path) => {
        const file = await readFile(path).catch(() => null)
        if (file && !file.lossy) contents.set(path, file.content)
      }),
    )
  }
  return findings.map((finding) => {
    const content = contents.get(finding.path)
    const excerpt =
      canExcerpt(finding) && content !== undefined ? excerptAround(content, finding.line) : null
    return { ...finding, excerpt }
  })
}
