import { hostMarkdown, redactSecrets } from '@cat-factory/kernel'

// Rendering for writing a requirements review's revised document into the description of the
// tracker issue(s) the task came from.
//
// The document is model-authored (the incorporation editor's reply) and is derived from text a
// customer wrote, so it is UNTRUSTED on its way onto a host-parsed surface: it goes through
// `redactSecrets` and `hostMarkdown.prose`, which keeps its Markdown structure while defusing
// mentions, issue references and closing keywords, and closes a fence it leaves open. Jira's
// transport decodes those defusing entities again when it converts to ADF, where text is inert.
//
// It REPLACES the description: the description is what everyone reads, and every tracker keeps its
// history, so the reporter's own words stay one click away. The opening line says so. The render is
// deterministic, which is what lets each adapter compare it with the stored description and skip a
// write that would change nothing.

/**
 * Longest document rendered, under GitHub's 65,536-character issue-body limit with room for the
 * opening line: a rejected write changes nothing, so a pathological document is cut (and the cut
 * marked) rather than lost. Jira's limit counts the converted ADF instead, so its adapter sizes its
 * own cut (`jiraFieldAdf`).
 */
const MAX_DOCUMENT_CHARS = 64_000

/** Render the revised requirements as an issue description, Markdown being the shared format. */
export function renderRefinedRequirementsDescription(document: string): string {
  return [
    '_cat-factory refined these requirements during review. The previous description is in this ' +
      "issue's history._",
    '',
    hostMarkdown.prose(redactSecrets(document.trim()) ?? '', MAX_DOCUMENT_CHARS),
  ].join('\n')
}
