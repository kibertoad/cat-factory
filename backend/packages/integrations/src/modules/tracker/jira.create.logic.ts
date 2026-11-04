// Pure helper for filing a Jira issue: the create request payload, its description converted to
// Atlassian Document Format by `markdown-adf.logic.ts`. Kept out of the worker so it is
// unit-testable without a live site.

import { markdownToAdf } from './markdown-adf.logic.js'

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
