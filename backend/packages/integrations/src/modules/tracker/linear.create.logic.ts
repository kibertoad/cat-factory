// Pure helpers for filing a Linear issue: the `issueCreate` GraphQL mutation, its
// variables, and parsing the response. Kept out of the service so they are
// unit-testable without a live API. Linear descriptions are Markdown, so (unlike
// Jira's `markdownToAdf`) the body passes through unchanged.

/** The `issueCreate` mutation (returns the created issue's identifier + URL). */
export const LINEAR_ISSUE_CREATE_MUTATION = `mutation CreateIssue($input: IssueCreateInput!) {
  issueCreate(input: $input) {
    success
    issue { identifier url }
  }
}`

/** Build the `issueCreate` variables. A team id is required by Linear's API. */
export function buildLinearIssueCreateVariables(input: {
  teamId: string
  title: string
  body: string
}): { input: Record<string, unknown> } {
  return {
    input: {
      teamId: input.teamId,
      title: input.title.slice(0, 250),
      description: input.body,
    },
  }
}

interface IssueCreatePayload {
  issueCreate?: {
    success?: boolean
    issue?: { identifier?: string; url?: string } | null
  }
}

/** Parse the `issueCreate` response into the filed ticket; throws on failure. */
export function parseLinearIssueCreateResponse(data: unknown): { externalId: string; url: string } {
  const payload = (data ?? {}) as IssueCreatePayload
  const issue = payload.issueCreate?.issue
  if (!payload.issueCreate?.success || !issue?.identifier) {
    throw new Error('Linear issueCreate did not return a created issue')
  }
  return {
    externalId: issue.identifier,
    url: issue.url ?? `https://linear.app/issue/${issue.identifier}`,
  }
}
