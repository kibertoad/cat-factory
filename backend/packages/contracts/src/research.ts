import * as v from 'valibot'
import { capabilityCredentialKeySchema } from './capability-credentials.js'
import {
  duplicateValues,
  describeValibotIssues,
  type DefinitionParseResult,
  type ProjectDefinition,
  type ProjectDefinitionSpecValidator,
  projectDefinitionChecks,
  projectDefinitionEntries,
  projectTargetSchema,
} from './project-definitions.js'
import type { ProjectOutcome } from './project-outcomes.js'

// ---------------------------------------------------------------------------
// The `research` project kind's own content: the spec its definitions carry (topics of
// questions), the body each of its outcome revisions holds (answers with evidence), and how
// those revisions fold. The platform stores all of it opaquely through the generic project
// definition and outcome contracts. Design: `docs/initiatives/research-projects.md`.
// ---------------------------------------------------------------------------

export const RESEARCH_KIND = 'research'

/** The body schema version a research outcome is written in today. */
export const RESEARCH_OUTCOME_SCHEMA_VERSION = 1

export const RESEARCH_TITLE_MAX = 200
export const RESEARCH_PROSE_MAX = 20_000
export const RESEARCH_SHORT_MAX = 2000
export const RESEARCH_TOPICS_MAX = 50
export const RESEARCH_QUESTIONS_PER_TOPIC_MAX = 100
export const RESEARCH_EVIDENCE_MAX = 50
export const RESEARCH_LEARNINGS_MAX = 100

/** The prefix every ad-hoc question id carries; a definition may not author an id under it. */
export const ADHOC_QUESTION_PREFIX = 'adhoc:'

const idPattern = /^[a-z0-9][a-z0-9_-]{0,79}$/
const stableId = v.pipe(v.string(), v.regex(idPattern, 'must be a lowercase slug'))
const title = v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(RESEARCH_TITLE_MAX))
const shortProse = v.pipe(v.string(), v.trim(), v.maxLength(RESEARCH_SHORT_MAX))
const prose = v.pipe(v.string(), v.maxLength(RESEARCH_PROSE_MAX))

export const researchQuestionSchema = v.object({
  /** Stable across versions: findings merge by this id. */
  id: stableId,
  question: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(RESEARCH_SHORT_MAX)),
  /** What a good answer looks like, for the agent and the reader. */
  answerHint: v.optional(shortProse),
})
export type ResearchQuestion = v.InferOutput<typeof researchQuestionSchema>

export const researchTopicSchema = v.object({
  id: stableId,
  title,
  questions: v.pipe(
    v.array(researchQuestionSchema),
    v.minLength(1),
    v.maxLength(RESEARCH_QUESTIONS_PER_TOPIC_MAX),
  ),
})
export type ResearchTopic = v.InferOutput<typeof researchTopicSchema>

/** Every question id in a definition, across its topics, in authored order. */
export function researchQuestionIds(topics: readonly ResearchTopic[]): string[] {
  return topics.flatMap((topic) => topic.questions.map((question) => question.id))
}

/** What a research definition says to find out, never how. */
export const researchSpecSchema = v.pipe(
  v.object({
    /** The goal, in prose, for the agent and the human. */
    brief: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(RESEARCH_PROSE_MAX)),
    topics: v.pipe(v.array(researchTopicSchema), v.minLength(1), v.maxLength(RESEARCH_TOPICS_MAX)),
  }),
  v.check(
    (s) => duplicateValues(s.topics.map((t) => t.id)).length === 0,
    'topic ids must be unique',
  ),
  v.check(
    (s) => duplicateValues(researchQuestionIds(s.topics)).length === 0,
    'question ids must be unique across the definition',
  ),
)
export type ResearchSpec = v.InferOutput<typeof researchSpecSchema>

const researchEnvelopeSchema = v.object({
  ...projectDefinitionEntries,
  kind: v.literal(RESEARCH_KIND),
  /** A research run browses and calls the vendor, so it names at least one target. */
  targets: v.pipe(v.array(projectTargetSchema), v.minLength(1)),
  spec: researchSpecSchema,
})

/** A project definition of the research kind, with its spec typed. */
export const researchDefinitionSchema = v.pipe(
  researchEnvelopeSchema,
  ...projectDefinitionChecks<v.InferOutput<typeof researchEnvelopeSchema>>(),
)
export type ResearchDefinition = v.InferOutput<typeof researchDefinitionSchema>
export type ResearchDefinitionInput = v.InferInput<typeof researchDefinitionSchema>

/** Validate a research definition, reporting every issue with the path it sits at. */
export function parseResearchDefinition(input: unknown): DefinitionParseResult<ResearchDefinition> {
  const result = v.safeParse(researchDefinitionSchema, input)
  return result.success
    ? { ok: true, value: result.output }
    : { ok: false, issues: describeValibotIssues(result.issues) }
}

/** The research kind's validator for the platform's definition registry and publisher. */
export const researchSpecValidator: ProjectDefinitionSpecValidator = {
  kind: RESEARCH_KIND,
  parseSpec: (definition: ProjectDefinition) => parseResearchDefinition(definition),
}

// ---------------------------------------------------------------------------
// Findings: the body of a research outcome revision
// ---------------------------------------------------------------------------

/** What a research task asks for: the research kind's outcome `intent` vocabulary. */
export const researchModeSchema = v.picklist(['initial', 'extend', 'clarify', 'refresh'])
export type ResearchMode = v.InferOutput<typeof researchModeSchema>

/** The id an ad-hoc question carries: namespaced to its task, so no definition can reuse it. */
export function adhocQuestionId(taskId: string, ordinal: number): string {
  return `${ADHOC_QUESTION_PREFIX}${taskId}:${ordinal}`
}

export function isAdhocQuestionId(questionId: string): boolean {
  return questionId.startsWith(ADHOC_QUESTION_PREFIX)
}

export const questionStatusSchema = v.picklist(['answered', 'partial', 'unanswered', 'blocked'])
export type QuestionStatus = v.InferOutput<typeof questionStatusSchema>

export const findingEvidenceSchema = v.variant('kind', [
  /** A recorded, redacted request/response pair. */
  v.object({ kind: v.literal('http-exchange'), ref: v.pipe(v.string(), v.minLength(1)) }),
  v.object({ kind: v.literal('screenshot'), artifactId: v.pipe(v.string(), v.minLength(1)) }),
  v.object({ kind: v.literal('url'), url: v.pipe(v.string(), v.url()) }),
  v.object({
    kind: v.literal('repo-path'),
    repoId: v.pipe(v.string(), v.minLength(1)),
    path: v.pipe(v.string(), v.minLength(1), v.maxLength(1000)),
  }),
])
export type FindingEvidence = v.InferOutput<typeof findingEvidenceSchema>

export const questionFindingSchema = v.pipe(
  v.object({
    /** A definition question id, or an ad-hoc one. */
    questionId: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
    status: questionStatusSchema,
    /** Markdown. */
    answer: v.optional(prose, ''),
    confidence: v.picklist(['high', 'medium', 'low']),
    evidence: v.optional(
      v.pipe(v.array(findingEvidenceSchema), v.maxLength(RESEARCH_EVIDENCE_MAX)),
      [],
    ),
    caveats: v.optional(v.array(shortProse), []),
    /** A `blocked` answer names the credential it waited for. */
    blockedOn: v.optional(v.object({ credentialKey: capabilityCredentialKeySchema })),
  }),
  v.check(
    (f) => (f.status === 'blocked') === (f.blockedOn !== undefined),
    'a blocked finding names the credential it waited for, and only a blocked one does',
  ),
)
export type QuestionFinding = v.InferOutput<typeof questionFindingSchema>

/** Something the agent found that no question asked about. */
export const researchLearningSchema = v.object({
  title,
  detail: v.optional(prose, ''),
})
export type ResearchLearning = v.InferOutput<typeof researchLearningSchema>

/** What one research task recorded. Written once per task and never rewritten. */
export const findingsRevisionBodySchema = v.pipe(
  v.object({
    summary: v.optional(prose, ''),
    findings: v.array(questionFindingSchema),
    learnings: v.optional(
      v.pipe(v.array(researchLearningSchema), v.maxLength(RESEARCH_LEARNINGS_MAX)),
      [],
    ),
  }),
  v.check(
    (body) => duplicateValues(body.findings.map((f) => f.questionId)).length === 0,
    'a revision answers each question at most once',
  ),
)
export type FindingsRevisionBody = v.InferOutput<typeof findingsRevisionBodySchema>

/** A research project's outcome revision, its body decoded. */
export type FindingsRevision = ProjectOutcome<FindingsRevisionBody>

/** Every screenshot a findings body references, for the outcome's `artifactRefs`. */
export function findingsArtifactRefs(body: FindingsRevisionBody): string[] {
  const refs = new Set<string>()
  for (const finding of body.findings)
    for (const evidence of finding.evidence)
      if (evidence.kind === 'screenshot') refs.add(evidence.artifactId)
  return [...refs]
}

/** A superseded or non-replacing answer kept beside the current one. */
export interface FindingNote {
  revisionId: string
  seq: number
  status: QuestionStatus
  answer: string
  blockedOn?: { credentialKey: string }
}

export interface FoldedFinding {
  finding: QuestionFinding
  /** The revision the current answer came from. */
  revisionId: string
  seq: number
  /** Later attempts that did not replace the answer (an `unanswered` or `blocked` re-check). */
  notes: FindingNote[]
}

export interface FoldedFindings {
  /** By question id. */
  byQuestion: Record<string, FoldedFinding>
  /** Every revision's learnings, oldest first, each tagged with its revision. */
  learnings: Array<ResearchLearning & { revisionId: string }>
  /** The newest revision's summary; empty when there is none. */
  summary: string
  /** The newest revision folded, or null when there are none. */
  latestRevisionId: string | null
}

function hasContent(status: QuestionStatus): boolean {
  return status === 'answered' || status === 'partial'
}

/** The parts of a revision the fold reads. */
export type FoldableFindingsRevision = Pick<FindingsRevision, 'id' | 'seq' | 'body'>

/**
 * The project's current findings: its revisions folded by question id in `seq` order (the order
 * the tasks were started, not the order they finished).
 *
 * A newer answer with content (`answered`, `partial`) replaces an older one. A newer `unanswered`
 * or `blocked` never replaces an answer with content and is kept beside it as a note, so a
 * re-check that ran out of budget or lost a login cannot erase what an earlier run established.
 */
export function foldFindings(revisions: readonly FoldableFindingsRevision[]): FoldedFindings {
  const ordered = [...revisions].sort((a, b) => a.seq - b.seq)
  const byQuestion: Record<string, FoldedFinding> = {}
  const learnings: FoldedFindings['learnings'] = []
  for (const revision of ordered) {
    for (const finding of revision.body.findings) {
      const current = byQuestion[finding.questionId]
      if (!current || hasContent(finding.status) || !hasContent(current.finding.status)) {
        byQuestion[finding.questionId] = {
          finding,
          revisionId: revision.id,
          seq: revision.seq,
          notes: current ? [...current.notes, noteOf(current)] : [],
        }
        continue
      }
      current.notes.push({
        revisionId: revision.id,
        seq: revision.seq,
        status: finding.status,
        answer: finding.answer,
        ...(finding.blockedOn ? { blockedOn: finding.blockedOn } : {}),
      })
    }
    for (const learning of revision.body.learnings)
      learnings.push({ ...learning, revisionId: revision.id })
  }
  const latest = ordered.at(-1)
  return {
    byQuestion,
    learnings,
    summary: latest?.body.summary ?? '',
    latestRevisionId: latest?.id ?? null,
  }
}

function noteOf(folded: FoldedFinding): FindingNote {
  return {
    revisionId: folded.revisionId,
    seq: folded.seq,
    status: folded.finding.status,
    answer: folded.finding.answer,
    ...(folded.finding.blockedOn ? { blockedOn: folded.finding.blockedOn } : {}),
  }
}

export type CoverageCounts = Record<QuestionStatus, number>

export interface ResearchCoverage {
  total: CoverageCounts
  byTopic: Array<{ topicId: string; counts: CoverageCounts }>
  /** Ad-hoc questions asked on tasks, outside the definition's topics. */
  adhoc: CoverageCounts
  /** Questions the definition no longer asks but a revision answered (an older version's). */
  retiredQuestionIds: string[]
}

function emptyCounts(): CoverageCounts {
  return { answered: 0, partial: 0, unanswered: 0, blocked: 0 }
}

/**
 * Coverage of a definition by the folded findings, computed by the platform from the agent's
 * per-question judgements. A question no revision answered counts as `unanswered`.
 */
export function researchCoverage(
  topics: readonly ResearchTopic[],
  adhocQuestionIds: readonly string[],
  folded: FoldedFindings,
): ResearchCoverage {
  const total = emptyCounts()
  const statusOf = (questionId: string): QuestionStatus =>
    folded.byQuestion[questionId]?.finding.status ?? 'unanswered'
  const byTopic = topics.map((topic) => {
    const counts = emptyCounts()
    for (const question of topic.questions) {
      const status = statusOf(question.id)
      counts[status] += 1
      total[status] += 1
    }
    return { topicId: topic.id, counts }
  })
  const adhoc = emptyCounts()
  for (const questionId of adhocQuestionIds) {
    const status = statusOf(questionId)
    adhoc[status] += 1
    total[status] += 1
  }
  const asked = new Set([...researchQuestionIds(topics), ...adhocQuestionIds])
  const retiredQuestionIds = Object.keys(folded.byQuestion).filter((id) => !asked.has(id))
  return { total, byTopic, adhoc, retiredQuestionIds }
}
