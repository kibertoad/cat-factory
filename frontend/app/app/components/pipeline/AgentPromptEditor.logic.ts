import type { AgentPromptDetail, AgentPromptRevision } from '~/types/agent-prompts'

// Pure decision logic for the agent system-prompt editor, split out of the component so the
// rules below are unit-testable without mounting Nuxt. Each one is a rule about the append-only
// revision log rather than about rendering, and each has a wrong answer that is silent rather
// than visible — which is why they are pinned rather than left inline in the template.

/**
 * What a save should send for the current draft.
 *
 * Two rules, both non-obvious:
 *
 * - **Text identical to the built-in is a REVERT, not a copy of it.** Storing the copy would pin
 *   the workspace to today's wording and quietly stop it tracking the product's prompt as that is
 *   improved — the whole reason the null revision exists.
 * - **`restoredFrom` only survives while the draft still IS that revision.** It is a claim the
 *   history renders ("restored from version 3"), so carrying it across an edit would label an
 *   entry as text it does not contain, and the next person tracing the log is misled by a record
 *   that looks authoritative. Comparing the text is what makes this total: it cannot be defeated
 *   by an edit-then-undo, and it needs no keystroke tracking in the component.
 */
export function saveIntent(
  draft: string,
  detail: Pick<AgentPromptDetail, 'builtinText' | 'revisions'> | null,
  restoredFrom: number | undefined,
): { text: string | null; restoredFrom?: number } {
  const text = draft.trim()
  const builtin = (detail?.builtinText ?? '').trim()
  const payload: { text: string | null } = { text: text === builtin ? null : text }
  const source = detail?.revisions.find((r) => r.revision === restoredFrom)
  if (!source) return payload
  // A null-text revision restores the built-in, so its "text" for this comparison is that.
  const sourceText = (source.text ?? detail?.builtinText ?? '').trim()
  return sourceText === text ? { ...payload, restoredFrom } : payload
}

/**
 * Whether the save button does anything. Trimmed on both sides because the payload is trimmed,
 * so trailing whitespace alone is not an edit — a save button that enables on it appends a
 * revision indistinguishable from its predecessor.
 */
export function isDirty(draft: string, detail: Pick<AgentPromptDetail, 'effectiveText'> | null) {
  return draft.trim() !== (detail?.effectiveText ?? '').trim()
}

/** The text `pick`ing a revision loads into the editor: its own, or the built-in for a revert. */
export function draftForRevision(
  revision: AgentPromptRevision,
  detail: Pick<AgentPromptDetail, 'builtinText'> | null,
): string {
  return revision.text ?? detail?.builtinText ?? ''
}

/** True when an error envelope is the append-only log's concurrent-editor refusal. */
export function isRevisionConflict(error: unknown): boolean {
  return (
    (error as { data?: { error?: { details?: { reason?: string } } } })?.data?.error?.details
      ?.reason === 'prompt_revision_conflict'
  )
}
