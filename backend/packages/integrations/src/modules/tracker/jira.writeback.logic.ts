import { type AdfDoc, markdownToAdfWithin } from './markdown-adf.logic.js'

// Pure helpers for Jira issue-tracker writeback: building the add-comment payload
// (POST /rest/api/3/issue/{key}/comment) and picking the transition that resolves
// an issue. Kept out of the service so they are unit-testable without a live site.

/**
 * Jira Cloud's limit on a text field (a comment body or an issue description), counted over the
 * stored value, which on REST v3 is the ADF JSON. Over it the call fails with
 * `CONTENT_LIMIT_EXCEEDED` and nothing is posted, on every retry.
 */
export const JIRA_FIELD_MAX_CHARS = 32_767

/** Appended to a body cut to fit {@link JIRA_FIELD_MAX_CHARS}. */
export const JIRA_TRUNCATION_NOTE = '(Cut short: the rest did not fit in one Jira field.)'

/** A Markdown body as the ADF Jira stores, cut to fit {@link JIRA_FIELD_MAX_CHARS}. */
export function jiraFieldAdf(markdown: string): AdfDoc {
  return markdownToAdfWithin(markdown, JIRA_FIELD_MAX_CHARS, JIRA_TRUNCATION_NOTE)
}

/** Build the POST /rest/api/3/issue/{key}/comment request body from a Markdown comment. */
export function buildJiraCommentPayload(body: string): { body: AdfDoc } {
  return { body: jiraFieldAdf(body) }
}

/** Build the PUT /rest/api/3/issue/{key} request body that replaces the description. */
export function buildJiraDescriptionPayload(description: AdfDoc): {
  fields: { description: AdfDoc }
} {
  return { fields: { description } }
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
