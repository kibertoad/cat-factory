import * as v from 'valibot'
import { capabilityCredentialKeySchema } from './capability-credentials.js'
import { taskTypeFieldDescriptorSchema } from './task-types.js'

// ---------------------------------------------------------------------------
// Research definitions and findings: the contract between an org-authored description of what
// to find out about a vendor and the structured answers a research run records. Design:
// `docs/initiatives/research-projects.md`.
// ---------------------------------------------------------------------------

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

/**
 * A definition key is namespaced, `<namespace>:<name>`. A stored definition's namespace must be
 * its account's own, so the code-registered and stored key spaces never meet.
 */
export const researchDefinitionKeySchema = v.pipe(
  v.string(),
  v.regex(
    /^[a-z0-9][a-z0-9-]{0,39}:[a-z0-9][a-z0-9-]{0,79}$/,
    'must be `<namespace>:<name>` in lowercase letters, digits and dashes',
  ),
)

/** The namespace half of a definition key. */
export function researchDefinitionNamespace(key: string): string {
  return key.slice(0, key.indexOf(':'))
}

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

export const researchCredentialKindSchema = v.picklist([
  'login',
  'api-token',
  'oauth-client',
  'secret',
])
export type ResearchCredentialKind = v.InferOutput<typeof researchCredentialKindSchema>

/** A credential the research needs, declared by NAME. The value lives in the credential store. */
export const researchCredentialSchema = v.object({
  key: capabilityCredentialKeySchema,
  kind: researchCredentialKindSchema,
  label: title,
  /** What the human does to obtain the credential from the vendor. */
  onboarding: v.optional(
    v.object({
      url: v.optional(v.pipe(v.string(), v.url())),
      instructions: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(RESEARCH_SHORT_MAX)),
    }),
  ),
  /** False: the agent asks for it when it reaches the point of need. */
  requiredAtStart: v.boolean(),
})
export type ResearchCredential = v.InferOutput<typeof researchCredentialSchema>

/** Where the vendor lives. A credential is only ever sent to one of these origins. */
export const researchTargetSchema = v.object({
  baseUrl: v.pipe(
    v.string(),
    v.url(),
    v.check((url) => url.startsWith('https://'), 'a research target must be https'),
  ),
  surface: v.picklist(['ui', 'api']),
})
export type ResearchTarget = v.InferOutput<typeof researchTargetSchema>

/** Every question id in a definition, across its topics, in authored order. */
export function researchQuestionIds(topics: readonly ResearchTopic[]): string[] {
  return topics.flatMap((topic) => topic.questions.map((question) => question.id))
}

function duplicates(values: readonly string[]): string[] {
  const seen = new Set<string>()
  const repeated = new Set<string>()
  for (const value of values) (seen.has(value) ? repeated : seen).add(value)
  return [...repeated]
}

/**
 * A versioned, org-authored description of one kind of research. It says what to find out,
 * never how. Immutable once published: a change is a new version.
 */
export const researchDefinitionSchema = v.pipe(
  v.object({
    key: researchDefinitionKeySchema,
    version: v.pipe(v.number(), v.integer(), v.minValue(1)),
    title,
    /** The goal, in prose, for the agent and the human. */
    brief: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(RESEARCH_PROSE_MAX)),
    topics: v.pipe(v.array(researchTopicSchema), v.minLength(1), v.maxLength(RESEARCH_TOPICS_MAX)),
    credentials: v.optional(v.array(researchCredentialSchema), []),
    targets: v.pipe(v.array(researchTargetSchema), v.minLength(1)),
    /** Per-project parameters, in the shared descriptor-form vocabulary. */
    inputs: v.optional(v.array(taskTypeFieldDescriptorSchema), []),
    /** Org steering appended to the named agent kind's prompt, as initiative presets do. */
    promptAdditions: v.optional(
      v.record(v.string(), v.pipe(v.string(), v.maxLength(RESEARCH_PROSE_MAX))),
      {},
    ),
  }),
  v.check((d) => duplicates(d.topics.map((t) => t.id)).length === 0, 'topic ids must be unique'),
  v.check(
    (d) => duplicates(researchQuestionIds(d.topics)).length === 0,
    'question ids must be unique across the definition',
  ),
  v.check(
    (d) => duplicates(d.credentials.map((c) => c.key)).length === 0,
    'credential keys must be unique',
  ),
  v.check(
    (d) => duplicates(d.inputs.map((field) => field.key)).length === 0,
    'input keys must be unique',
  ),
)
export type ResearchDefinition = v.InferOutput<typeof researchDefinitionSchema>
export type ResearchDefinitionInput = v.InferInput<typeof researchDefinitionSchema>

// ---------------------------------------------------------------------------
// Findings
// ---------------------------------------------------------------------------

/** What a research task asks for. */
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
    (body) => duplicates(body.findings.map((f) => f.questionId)).length === 0,
    'a revision answers each question at most once',
  ),
)
export type FindingsRevisionBody = v.InferOutput<typeof findingsRevisionBodySchema>

/** A findings revision's identity, without its body. */
export const findingsRevisionMetaSchema = v.object({
  id: v.string(),
  projectId: v.string(),
  /** The research task that wrote it. */
  taskId: v.string(),
  /** Per-project order, taken when the TASK started. */
  seq: v.pipe(v.number(), v.integer(), v.minValue(1)),
  mode: researchModeSchema,
  definitionKey: researchDefinitionKeySchema,
  definitionVersion: v.pipe(v.number(), v.integer(), v.minValue(1)),
  createdAt: v.number(),
})
export type FindingsRevisionMeta = v.InferOutput<typeof findingsRevisionMetaSchema>

export interface FindingsRevision extends FindingsRevisionMeta {
  body: FindingsRevisionBody
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

/**
 * The project's current findings: its revisions folded by question id in `seq` order (the order
 * the tasks were started, not the order they finished).
 *
 * A newer answer with content (`answered`, `partial`) replaces an older one. A newer `unanswered`
 * or `blocked` never replaces an answer with content and is kept beside it as a note, so a
 * re-check that ran out of budget or lost a login cannot erase what an earlier run established.
 */
export function foldFindings(revisions: readonly FindingsRevision[]): FoldedFindings {
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

// ---------------------------------------------------------------------------
// Findings storage policy
// ---------------------------------------------------------------------------

/** The largest inline threshold any tier may set; a facade's own row cap may be lower. */
export const FINDINGS_INLINE_MAX_BYTES_CEILING = 2_000_000
export const DEFAULT_FINDINGS_INLINE_MAX_BYTES = 256 * 1024

/**
 * One tier's findings-storage policy. Each field is optional: absence means "inherit from the
 * wider tier", and a stored null is never written.
 */
export const findingsStoragePolicySchema = v.object({
  inlineMaxBytes: v.optional(
    v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(FINDINGS_INLINE_MAX_BYTES_CEILING)),
  ),
  offload: v.optional(v.picklist(['enabled', 'disabled'])),
})
export type FindingsStoragePolicy = v.InferOutput<typeof findingsStoragePolicySchema>

/** Validate a research definition, reporting every issue with the path it sits at. */
export function parseResearchDefinition(
  input: unknown,
): { ok: true; definition: ResearchDefinition } | { ok: false; issues: string[] } {
  const result = v.safeParse(researchDefinitionSchema, input)
  if (result.success) return { ok: true, definition: result.output }
  return {
    ok: false,
    issues: result.issues.map((issue) => {
      const path = v.getDotPath(issue)
      return path ? `${path}: ${issue.message}` : issue.message
    }),
  }
}
