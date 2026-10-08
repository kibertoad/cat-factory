import { resolvePrNumber, type GuidedReviewFailureReason } from '@cat-factory/contracts'
import type {
  GuidedReviewMessage,
  GuidedReviewSessionView,
  OpenGuidedReviewInput,
  OpenGuidedReviewThreadInput,
} from '~/types/domain'

/** A cited span as one short label: `path:12-18`, `path:12`, or the bare path. */
export function citationLabel(anchor: {
  path: string
  startLine?: number
  endLine?: number
}): string {
  if (anchor.startLine === undefined) return anchor.path
  if (anchor.endLine === undefined || anchor.endLine === anchor.startLine) {
    return `${anchor.path}:${anchor.startLine}`
  }
  return `${anchor.path}:${anchor.startLine}-${anchor.endLine}`
}

/** A message that is still being produced: the thread is waiting on it. */
export function isLive(message: Pick<GuidedReviewMessage, 'status'>): boolean {
  return message.status === 'pending' || message.status === 'running'
}

/** Whether a thread may take another question now. Other threads never affect this. */
export function canAsk(messages: Pick<GuidedReviewMessage, 'status' | 'role'>[]): boolean {
  return !messages.some((m) => m.role === 'assistant' && isLive(m))
}

/**
 * The tab ids the window shows, oldest thread first, then the unsaved new-thread tab when one is
 * open. A new thread is only created on its first question, so an empty tab never reaches the
 * server.
 */
export const NEW_THREAD_TAB = '__new__'

export function threadTabs(
  view: GuidedReviewSessionView | undefined,
  draftOpen: boolean,
): string[] {
  const ids = (view?.threads ?? []).map((t) => t.id)
  return draftOpen ? [...ids, NEW_THREAD_TAB] : ids
}

/**
 * What clicking a suggested question does: open a NEW thread asking it. A thread keeps one line
 * of inquiry, so a suggestion never joins the context of whatever tab happens to be active, and a
 * busy tab can never refuse it.
 */
export function suggestedQuestionThread(question: string): OpenGuidedReviewThreadInput {
  return { question: { content: question } }
}

/**
 * The pull request a `review` task targets, as a guided review opens it: its number from the
 * task fields or its URL, and the repository of the service it sits in. Null when either is
 * unknown.
 */
export function reviewTaskTarget(
  fields: { prNumber?: number; prUrl?: string } | null | undefined,
  repo: { owner: string; name: string; provider?: 'github' | 'gitlab' } | undefined,
): OpenGuidedReviewInput | null {
  if (!repo) return null
  const prNumber = resolvePrNumber(fields)
  if (prNumber === null) return null
  return {
    owner: repo.owner,
    repo: repo.name,
    prNumber,
    ...(repo.provider ? { provider: repo.provider } : {}),
  }
}

/** The catalog key a failure reason is translated under. */
export function failureKey(reason: GuidedReviewFailureReason): string {
  return `guidedReview.failure.${reason}`
}

/** Where a refused draft would have gone: `path:line`, or the path when it named no line. */
export function droppedAnchor(dropped: { path: string; line: number | null }): string {
  return dropped.line === null ? dropped.path : `${dropped.path}:${dropped.line}`
}

/** A draft's anchor: `path:line`, or `path:start-line` for a span. */
export function draftAnchor(draft: {
  path: string
  line: number
  startLine: number | null
}): string {
  return draft.startLine
    ? `${draft.path}:${draft.startLine}-${draft.line}`
    : `${draft.path}:${draft.line}`
}

/** How many drafts one comment-drafts message produced that are still listed. */
export function keptDrafts(drafts: { messageId: string }[], messageId: string): number {
  return drafts.filter((d) => d.messageId === messageId).length
}

/** The session is reviewing an older head than the PR's latest known one. */
export function isStale(
  reviewedHeadSha: string,
  latestHeadSha: string | null | undefined,
): boolean {
  return !!latestHeadSha && latestHeadSha !== reviewedHeadSha
}
