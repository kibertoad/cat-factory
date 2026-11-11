import {
  type ProjectBoardView,
  type QuestionStatus,
  type ResearchMode,
  type ResearchProjectView,
  type ResearchTopic,
  isAdhocQuestionId,
  parseResearchDefinition,
} from '@cat-factory/contracts'
import type { BadgeColor } from '~/utils/badge'

/** The status chip colour of a question's current answer. */
export const QUESTION_STATUS_COLOR: Record<QuestionStatus, BadgeColor> = {
  answered: 'success',
  partial: 'warning',
  unanswered: 'neutral',
  blocked: 'error',
}

/** What the research reader reads off a project's board view: its kind's view and the topics asked. */
export interface ResearchReading {
  view: ResearchProjectView
  /** The pinned definition's topics; empty when it no longer resolves. */
  topics: ResearchTopic[]
}

/**
 * The research reading of a project's board view. The view is the research kind's own, served
 * opaquely; null when the project carries none (a board view read before its kind's module).
 */
export function researchReadingOf(board: ProjectBoardView): ResearchReading | null {
  if (!board.view) return null
  const parsed = board.definition ? parseResearchDefinition(board.definition) : undefined
  return {
    view: board.view as ResearchProjectView,
    topics: parsed?.ok ? parsed.value.spec.topics : [],
  }
}

/** One question as the reader lists it: its text, and its current answer when it has one. */
export interface ReaderQuestion {
  id: string
  question: string
  folded: ResearchProjectView['findings'][number] | undefined
  status: QuestionStatus
}

export interface ReaderTopic {
  id: string
  title: string
  questions: ReaderQuestion[]
}

/**
 * The view's questions grouped as the reader shows them: each definition topic in order, then the
 * ad-hoc questions tasks added, then answers to questions the pinned version no longer asks. A
 * question no revision answered reads as `unanswered`, the same judgement the coverage makes.
 */
export function readerTopics({ view, topics: asked }: ResearchReading): {
  topics: ReaderTopic[]
  adhoc: ReaderQuestion[]
  retired: ReaderQuestion[]
} {
  const byId = new Map(view.findings.map((f) => [f.finding.questionId, f]))
  const entry = (id: string, question: string): ReaderQuestion => {
    const folded = byId.get(id)
    return { id, question, folded, status: folded?.finding.status ?? 'unanswered' }
  }
  const topics = asked.map((topic) => ({
    id: topic.id,
    title: topic.title,
    questions: topic.questions.map((q) => entry(q.id, q.question)),
  }))
  const known = new Set(topics.flatMap((t) => t.questions.map((q) => q.id)))
  const adhocText = new Map(view.adhocQuestions.map((q) => [q.id, q.question]))
  const adhocIds = [
    ...new Set([...adhocText.keys(), ...view.findings.map((f) => f.finding.questionId)]),
  ].filter(isAdhocQuestionId)
  const adhoc = adhocIds.map((id) => entry(id, adhocText.get(id) ?? id))
  for (const id of adhocIds) known.add(id)
  const retired = view.findings
    .filter((f) => !known.has(f.finding.questionId))
    .map((f) => entry(f.finding.questionId, f.finding.questionId))
  return { topics, adhoc, retired }
}

/**
 * The questions a follow-up of `mode` may name to revisit. `clarify` offers what is still open
 * (`partial` or `blocked`), `refresh` offers everything answered so far; `initial` and `extend`
 * name none, since they choose their own questions.
 */
export function revisitableQuestions(
  reading: ResearchReading,
  mode: ResearchMode,
): ReaderQuestion[] {
  if (mode !== 'clarify' && mode !== 'refresh') return []
  const { topics, adhoc } = readerTopics(reading)
  const all = [...topics.flatMap((t) => t.questions), ...adhoc]
  return mode === 'clarify'
    ? all.filter((q) => q.status === 'partial' || q.status === 'blocked')
    : all.filter((q) => q.folded !== undefined)
}

/** Ad-hoc questions typed one per line, blank lines dropped. */
export function parseAdhocQuestions(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
}
