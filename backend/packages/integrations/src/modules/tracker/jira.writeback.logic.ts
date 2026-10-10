import { markdownToAdf } from './jira.create.logic.js'

// Pure helpers for Jira issue-tracker writeback: building the add-comment payload
// (POST /rest/api/3/issue/{key}/comment) and picking the transition that resolves
// an issue. Kept out of the service so they are unit-testable without a live site.

/** Build the POST /rest/api/3/issue/{key}/comment request body from a Markdown comment. */
export function buildJiraCommentPayload(body: string): Record<string, unknown> {
  return { body: markdownToAdf(body) }
}

/** One transition as returned by GET /rest/api/3/issue/{key}/transitions. */
export interface JiraTransition {
  id?: string
  name?: string
  to?: { statusCategory?: { key?: string } }
}

/**
 * Pick the transition that moves an issue into one of Jira's standard status
 * categories: `done` (resolve on merge) or `indeterminate` (Jira's "In
 * Progress" category — the intake pickup mark). Auto-detection only — no
 * per-project mapping. Returns the first matching transition, the conventional
 * action in a standard workflow, or null if none is available.
 */
export function pickTransitionByCategory(
  transitions: JiraTransition[],
  category: 'indeterminate' | 'done',
): JiraTransition | null {
  return transitions.find((t) => t.to?.statusCategory?.key === category && t.id) ?? null
}
