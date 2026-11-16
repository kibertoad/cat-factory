import * as v from 'valibot'
import {
  adhocQuestionSchema,
  type AdhocQuestion,
  type FoldableFindingsRevision,
  isAdhocQuestionId,
  foldFindings,
  questionFindingSchema,
  questionStatusSchema,
  researchCoverage,
  researchLearningSchema,
  type ResearchTopic,
} from './research.js'

// The research kind's VIEW of a project: its findings revisions folded by question id, with the
// coverage of the pinned definition. The public API serves it opaquely, beside its JSON Schema
// (`GET /api/v1/project-kinds/research`), and the SPA's findings reader renders the same shape.

const coverageCountsSchema = v.object({
  answered: v.number(),
  partial: v.number(),
  unanswered: v.number(),
  blocked: v.number(),
})

/** One question's current answer, the revision it came from, and attempts that did not replace it. */
const foldedFindingSchema = v.object({
  finding: questionFindingSchema,
  revisionId: v.string(),
  seq: v.number(),
  notes: v.array(
    v.object({
      revisionId: v.string(),
      seq: v.number(),
      status: questionStatusSchema,
      answer: v.string(),
      blockedOn: v.optional(v.object({ credentialKey: v.string() })),
    }),
  ),
})

export const researchProjectViewSchema = v.object({
  /** The newest revision's summary; empty when there is none. */
  summary: v.string(),
  latestRevisionId: v.nullable(v.string()),
  findings: v.array(foldedFindingSchema),
  learnings: v.array(v.object({ ...researchLearningSchema.entries, revisionId: v.string() })),
  /** The text of every ad-hoc question a revision answered, by its `adhoc:` id. */
  adhocQuestions: v.array(adhocQuestionSchema),
  coverage: v.object({
    total: coverageCountsSchema,
    byTopic: v.array(v.object({ topicId: v.string(), counts: coverageCountsSchema })),
    adhoc: coverageCountsSchema,
    retiredQuestionIds: v.array(v.string()),
  }),
})
export type ResearchProjectView = v.InferOutput<typeof researchProjectViewSchema>

/** The view of a research project whose definition asks `topics`, over its revisions. */
export function researchProjectView(
  topics: readonly ResearchTopic[],
  revisions: readonly FoldableFindingsRevision[],
): ResearchProjectView {
  const folded = foldFindings(revisions)
  const adhocQuestions = adhocQuestionsOf(revisions)
  const adhocIds = [
    ...new Set([
      ...adhocQuestions.map((q) => q.id),
      ...Object.keys(folded.byQuestion).filter((id) => isAdhocQuestionId(id)),
    ]),
  ]
  return {
    summary: folded.summary,
    latestRevisionId: folded.latestRevisionId,
    findings: Object.values(folded.byQuestion),
    learnings: folded.learnings,
    adhocQuestions,
    coverage: researchCoverage(topics, adhocIds, folded),
  }
}

/** The text of every ad-hoc question the revisions answered, the newest wording winning. */
function adhocQuestionsOf(revisions: readonly FoldableFindingsRevision[]): AdhocQuestion[] {
  const byId = new Map<string, AdhocQuestion>()
  for (const revision of [...revisions].sort((a, b) => a.seq - b.seq)) {
    for (const question of revision.body.adhocQuestions) byId.set(question.id, question)
  }
  return [...byId.values()]
}
