import { hostMarkdown, redactSecrets } from '@cat-factory/kernel'
import { PLATFORM_COMMENT_MARKER } from './reviewReplies.logic.js'

// Rendering + keying for posting a requirements review's revised document back onto the tracker
// issue(s) the task came from.
//
// The document is model-authored (the incorporation editor's reply) and is derived from text a
// customer wrote, so it is UNTRUSTED on its way onto a host-parsed surface: it goes through
// `redactSecrets` and `hostMarkdown.prose`, which keeps its Markdown structure while defusing
// mentions, issue references and closing keywords, and closes a fence it leaves open. Jira's
// transport decodes those defusing entities again when it converts to ADF, where text is inert.
//
// It is posted as a COMMENT, never written over the issue's description: the reporter's own words
// stay where they were, and the revision sits under them with the platform marker that keeps the
// inbound reply path from reading it as a human's comment.

/**
 * Longest document rendered. Jira Cloud rejects a comment over roughly 32k characters, and a
 * rejected comment posts nothing, so a pathological document is cut (and the cut marked) rather
 * than lost. A realistic requirements document is far below it.
 */
const MAX_DOCUMENT_CHARS = 28_000

/** Render the revised requirements as one tracker comment, Markdown being the shared format. */
export function renderRefinedRequirementsComment(document: string): string {
  return [
    `${PLATFORM_COMMENT_MARKER}cat-factory refined the requirements for this issue during ` +
      'review. The issue description above is unchanged. The work will be built against the ' +
      'revised requirements below.',
    '',
    '---',
    '',
    hostMarkdown.prose(redactSecrets(document.trim()) ?? '', MAX_DOCUMENT_CHARS),
  ].join('\n')
}

/**
 * The marker's document key: lowercase hex SHA-256 of the document as stored, so posting the same
 * document again is recognised and a revised one is a new post.
 */
export async function refinedDocumentHash(document: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(document))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}
