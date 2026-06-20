// Pure helpers for filing a Jira issue: converting a Markdown body into the
// minimal Atlassian Document Format (ADF) Jira's create API expects, and building
// the request payload. Kept out of the worker so it is unit-testable without a
// live site (the inverse of `jira.logic.ts`'s `adfToMarkdown`).

interface AdfText {
  type: 'text'
  text: string
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

/**
 * Convert lightweight Markdown into ADF. Deliberately minimal — paragraphs split
 * on blank lines, `#`/`##`/`###` headings, and `- ` bullet lists — which covers
 * the analysis reports the tech-debt pipeline produces. Anything else is carried
 * through as paragraph text so no content is lost. An empty body yields a single
 * empty paragraph (ADF requires non-empty `content`).
 */
export function markdownToAdf(markdown: string): AdfDoc {
  const blocks = markdown.replace(/\r\n/g, '\n').split(/\n{2,}/)
  const content: AdfNode[] = []
  for (const raw of blocks) {
    const block = raw.trim()
    if (!block) continue
    const heading = block.match(/^(#{1,3})\s+(.*)$/)
    if (heading) {
      content.push({
        type: 'heading',
        attrs: { level: heading[1]!.length },
        content: [{ type: 'text', text: heading[2]!.trim() }],
      })
      continue
    }
    const lines = block.split('\n')
    const isList = lines.every((l) => /^\s*[-*]\s+/.test(l))
    if (isList) {
      content.push({
        type: 'bulletList',
        content: lines.map((l) => ({
          type: 'listItem',
          content: [
            { type: 'paragraph', content: [{ type: 'text', text: l.replace(/^\s*[-*]\s+/, '') }] },
          ],
        })),
      })
      continue
    }
    content.push({ type: 'paragraph', content: [{ type: 'text', text: lines.join(' ') }] })
  }
  if (content.length === 0) content.push({ type: 'paragraph', content: [] })
  return { type: 'doc', version: 1, content }
}

/** Build the POST /rest/api/3/issue request body for a new issue. */
export function buildJiraIssuePayload(input: {
  projectKey: string
  title: string
  body: string
  issueType?: string
}): Record<string, unknown> {
  return {
    fields: {
      project: { key: input.projectKey },
      summary: input.title.slice(0, 250),
      description: markdownToAdf(input.body),
      issuetype: { name: input.issueType ?? 'Task' },
    },
  }
}
