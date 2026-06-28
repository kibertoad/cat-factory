// Pure helpers for Linear issue-tracker writeback: the GraphQL documents +
// variable builders for commenting on an issue and transitioning it to a completed
// workflow state, plus picking that state. Kept out of the service so they are
// unit-testable without a live API.
//
// Linear identifies issues by a UUID in mutations (the stored external id is the
// human identifier `ENG-123`, which the `issue(id:)` read resolves but the
// mutations want the UUID), so writeback first looks the issue up to get its UUID
// (and, for resolve, its team's workflow states), then mutates. Linear has no
// native "close" — resolution is a transition to a `completed`-type state, the
// analogue of Jira's Done category.

/** Look up an issue's UUID by its identifier (for the comment mutation). */
export const LINEAR_ISSUE_ID_QUERY = `query IssueId($id: String!) {
  issue(id: $id) { id }
}`

/** Look up an issue's UUID plus its team's workflow states (for resolve). */
export const LINEAR_ISSUE_RESOLVE_LOOKUP_QUERY = `query IssueResolveLookup($id: String!) {
  issue(id: $id) {
    id
    team { states { nodes { id type } } }
  }
}`

/** The `commentCreate` mutation. */
export const LINEAR_COMMENT_CREATE_MUTATION = `mutation CommentCreate($input: CommentCreateInput!) {
  commentCreate(input: $input) { success }
}`

/** The `issueUpdate` mutation (used to set the resolved state). */
export const LINEAR_ISSUE_UPDATE_MUTATION = `mutation IssueUpdate($id: String!, $input: IssueUpdateInput!) {
  issueUpdate(id: $id, input: $input) { success }
}`

/** Build the `commentCreate` variables (issue UUID + Markdown body). */
export function buildLinearCommentVariables(
  issueId: string,
  body: string,
): { input: Record<string, unknown> } {
  return { input: { issueId, body } }
}

/** Build the `issueUpdate` variables that move an issue to a workflow state. */
export function buildLinearStateUpdateVariables(
  issueId: string,
  stateId: string,
): { id: string; input: Record<string, unknown> } {
  return { id: issueId, input: { stateId } }
}

/** One workflow state as returned by the team-states lookup. */
export interface LinearWorkflowState {
  id?: string
  type?: string
}

/**
 * Pick the id of the team's **completed**-type workflow state (Linear's standard
 * resolved category), or null if none exists. Returns the first match, the
 * conventional resolve target in a default workflow.
 */
export function pickCompletedStateId(states: LinearWorkflowState[]): string | null {
  return states.find((s) => s.type === 'completed' && s.id)?.id ?? null
}
