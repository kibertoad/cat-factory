import * as v from 'valibot'
import { projectSlugSchema } from './project-slug.js'

// ---------------------------------------------------------------------------
// A project stage's exit criteria, and the report of whether its result meets them. The model
// argues each criterion (met or unmet, with passages quoted from the result); the platform
// computes the status from the quotes, and a person decides at the stage's checkpoint. Design:
// `docs/initiatives/staged-project-definitions.md`.
// ---------------------------------------------------------------------------

export const STAGE_ACCEPTANCE_CRITERIA_MAX = 20
export const STAGE_ACCEPTANCE_STATEMENT_MAX = 1000
export const STAGE_ACCEPTANCE_EVIDENCE_MAX = 5
export const STAGE_ACCEPTANCE_TEXT_MAX = 2000
/** The shortest quoted passage that counts as evidence; a shorter one proves nothing. */
export const STAGE_ACCEPTANCE_PASSAGE_MIN = 12

/** One thing a stage's result must show. */
export const stageAcceptanceCriterionSchema = v.object({
  id: projectSlugSchema,
  statement: v.pipe(
    v.string(),
    v.trim(),
    v.minLength(1),
    v.maxLength(STAGE_ACCEPTANCE_STATEMENT_MAX),
  ),
})
export type StageAcceptanceCriterion = v.InferOutput<typeof stageAcceptanceCriterionSchema>

/** A stage's exit criteria, ids unique. */
export const stageAcceptanceSchema = v.pipe(
  v.array(stageAcceptanceCriterionSchema),
  v.minLength(1),
  v.maxLength(STAGE_ACCEPTANCE_CRITERIA_MAX),
  v.check((cs) => new Set(cs.map((c) => c.id)).size === cs.length, 'criterion ids must be unique'),
)

/**
 * `met`: claimed met, and every quoted passage is in the result. `unmet`: claimed unmet.
 * `unverified`: claimed met with no passage, or one the result does not hold, or not argued.
 */
export const stageCriterionStatusSchema = v.picklist(['met', 'unmet', 'unverified'])
export type StageCriterionStatus = v.InferOutput<typeof stageCriterionStatusSchema>

const text = v.pipe(v.string(), v.maxLength(STAGE_ACCEPTANCE_TEXT_MAX))

export const stageCriterionReportSchema = v.object({
  id: projectSlugSchema,
  statement: v.string(),
  status: stageCriterionStatusSchema,
  /** What the assessment argued, or null when it left the criterion out. */
  claim: v.nullable(v.picklist(['met', 'unmet'])),
  rationale: text,
  /** The passages it quoted from the result. */
  evidence: v.array(text),
  /** The quoted passages the result does not hold, or too short to count. */
  unfound: v.array(text),
  /** Quotes past the most a criterion may give, which were not checked; any blocks `met`. */
  dropped: v.optional(v.number(), 0),
})
export type StageCriterionReport = v.InferOutput<typeof stageCriterionReportSchema>

/**
 * Whether a stage's result meets its exit criteria. `assessed`: the assessor replied, and each
 * criterion carries its computed status. `unavailable`: no assessor is wired. `failed`: the
 * assessment could not run, or its reply named no criterion in the expected shape; `note` says
 * which. `pending`: the result has not been assessed yet. Outside `assessed`, every criterion is
 * `unverified`, and a later assessment may replace the report.
 */
export const stageAcceptanceReportSchema = v.object({
  /**
   * The outcome assessed: the task's own result. When a person accepted a revision of it, this
   * still names the result the model produced, not the revision.
   */
  outcomeId: v.string(),
  assessedAt: v.number(),
  state: v.picklist(['assessed', 'unavailable', 'failed', 'pending']),
  note: v.optional(text),
  /** The model the assessment ran on. */
  model: v.optional(v.string()),
  criteria: v.array(stageCriterionReportSchema),
})
export type StageAcceptanceReport = v.InferOutput<typeof stageAcceptanceReportSchema>

/** A stored report, or null when it no longer parses. */
export function parseStageAcceptanceReport(json: string): StageAcceptanceReport | null {
  let value: unknown
  try {
    value = JSON.parse(json)
  } catch {
    return null
  }
  const parsed = v.safeParse(stageAcceptanceReportSchema, value)
  return parsed.success ? parsed.output : null
}

/** One criterion as the assessment argued it, read leniently from its reply. */
interface ArguedCriterion {
  id: string
  claim: 'met' | 'unmet'
  rationale: string
  evidence: string[]
  /** How many quotes past the limit were left unchecked. */
  dropped: number
}

/**
 * The criteria a reply argued, by id; an entry that does not parse is left out. Null when the
 * reply carries no `criteria` list at all.
 */
function arguedCriteria(reply: unknown): Map<string, ArguedCriterion> | null {
  const list = (reply as { criteria?: unknown } | null)?.criteria
  const argued = new Map<string, ArguedCriterion>()
  if (!Array.isArray(list)) return null
  for (const entry of list) {
    const e = entry as Record<string, unknown> | null
    if (!e || typeof e.id !== 'string' || (e.claim !== 'met' && e.claim !== 'unmet')) continue
    const quotes = (Array.isArray(e.evidence) ? e.evidence : []).filter(
      (q): q is string => typeof q === 'string',
    )
    argued.set(e.id, {
      id: e.id,
      claim: e.claim,
      rationale:
        typeof e.rationale === 'string' ? e.rationale.slice(0, STAGE_ACCEPTANCE_TEXT_MAX) : '',
      evidence: quotes
        .slice(0, STAGE_ACCEPTANCE_EVIDENCE_MAX)
        .map((q) => q.slice(0, STAGE_ACCEPTANCE_TEXT_MAX)),
      dropped: Math.max(0, quotes.length - STAGE_ACCEPTANCE_EVIDENCE_MAX),
    })
  }
  return argued
}

const normalized = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase()

/**
 * The report for an assessment's reply: each criterion's status computed from what it argued and
 * whether the result holds every passage it quoted. Whitespace and case do not count.
 */
export function computeStageAcceptance(input: {
  outcomeId: string
  assessedAt: number
  model: string
  criteria: readonly StageAcceptanceCriterion[]
  /** The stage's result as the assessment read it. */
  result: string
  reply: unknown
}): StageAcceptanceReport {
  const argued = arguedCriteria(input.reply)
  if (!argued || argued.size === 0) {
    return unassessedStageAcceptance({
      ...input,
      state: 'failed',
      note: 'The assessment replied without arguing any criterion in the expected shape.',
    })
  }
  const haystack = normalized(input.result)
  const criteria = input.criteria.map((criterion): StageCriterionReport => {
    const claim = argued.get(criterion.id)
    if (!claim) {
      return {
        ...criterion,
        status: 'unverified',
        claim: null,
        rationale: '',
        evidence: [],
        unfound: [],
        dropped: 0,
      }
    }
    const unfound = claim.evidence.filter(
      (q) =>
        normalized(q).length < STAGE_ACCEPTANCE_PASSAGE_MIN || !haystack.includes(normalized(q)),
    )
    const status: StageCriterionStatus =
      claim.claim === 'unmet'
        ? 'unmet'
        : claim.evidence.length > 0 && unfound.length === 0 && claim.dropped === 0
          ? 'met'
          : 'unverified'
    return {
      ...criterion,
      status,
      claim: claim.claim,
      rationale: claim.rationale,
      evidence: claim.evidence,
      unfound,
      dropped: claim.dropped,
    }
  })
  return {
    outcomeId: input.outcomeId,
    assessedAt: input.assessedAt,
    state: 'assessed',
    model: input.model,
    criteria,
  }
}

/** A report that assessed nothing: every criterion `unverified`, the reason stated. */
export function unassessedStageAcceptance(input: {
  outcomeId: string
  assessedAt: number
  criteria: readonly StageAcceptanceCriterion[]
  state: 'unavailable' | 'failed' | 'pending'
  note: string
}): StageAcceptanceReport {
  return {
    outcomeId: input.outcomeId,
    assessedAt: input.assessedAt,
    state: input.state,
    note: input.note.slice(0, STAGE_ACCEPTANCE_TEXT_MAX),
    criteria: input.criteria.map((c) => ({
      ...c,
      status: 'unverified',
      claim: null,
      rationale: '',
      evidence: [],
      unfound: [],
      dropped: 0,
    })),
  }
}
