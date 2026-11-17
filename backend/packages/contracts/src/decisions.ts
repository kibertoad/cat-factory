import * as v from 'valibot'
import { type DefinitionParseResult, describeValibotIssues } from './project-definitions.js'

// ---------------------------------------------------------------------------
// The DECISIONS task type: a decision register. Its agent proposes the decisions a body of work
// needs (each a question with options, a recommended default, the trade-off and the evidence) from
// what earlier stages found; a person settles every item at the stage's checkpoint, and the settled
// register is what later stages read. The model argues, the person decides. Design:
// `docs/initiatives/staged-project-definitions.md`.
// ---------------------------------------------------------------------------

/** The built-in task type a decision register runs as. */
export const DECISIONS_TASK_TYPE = 'decisions'

/** The agent kind a decision stage's task dispatches. */
export const PROJECT_DECIDER_AGENT_KIND = 'project-decider'

/** The body schema version a decision register is written in today. */
export const DECISION_REGISTER_SCHEMA_VERSION = 1

export const DECISION_ITEMS_MAX = 100
export const DECISION_OPTIONS_MAX = 10
export const DECISION_PROSE_MAX = 20_000
export const DECISION_SHORT_MAX = 2000

const itemId = v.pipe(v.string(), v.regex(/^[a-z0-9][a-z0-9_-]{0,79}$/, 'must be a lowercase slug'))
const short = v.pipe(v.string(), v.trim(), v.maxLength(DECISION_SHORT_MAX))
const required = v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(DECISION_SHORT_MAX))

/** What a decision stage asks to be decided: a brief, and any questions it must cover. */
export const decisionStageConfigSchema = v.object({
  brief: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(DECISION_PROSE_MAX)),
  /** Questions the register must answer, by stable id; the agent may add more of its own. */
  questions: v.optional(
    v.pipe(
      v.array(v.object({ id: itemId, question: required })),
      v.maxLength(DECISION_ITEMS_MAX),
      v.check(
        (qs) => new Set(qs.map((q) => q.id)).size === qs.length,
        'question ids must be unique',
      ),
    ),
    [],
  ),
})
export type DecisionStageConfig = v.InferOutput<typeof decisionStageConfigSchema>

/** A person's settlement of one item. */
export const registerDecisionSchema = v.object({
  choice: required,
  note: v.optional(short),
  decidedBy: v.nullable(v.string()),
  decidedAt: v.number(),
})
export type RegisterDecision = v.InferOutput<typeof registerDecisionSchema>

export const decisionItemSchema = v.object({
  id: itemId,
  question: required,
  options: v.pipe(v.array(required), v.maxLength(DECISION_OPTIONS_MAX)),
  /** The agent's recommended default. */
  recommendation: required,
  /** Why, and what choosing otherwise costs. */
  rationale: short,
  /** Where the recommendation comes from: findings, refs, observations. */
  evidence: v.pipe(v.array(short), v.maxLength(50)),
  /** Null until a person settles it at the checkpoint. */
  decision: v.optional(v.nullable(registerDecisionSchema), null),
})
export type DecisionItem = v.InferOutput<typeof decisionItemSchema>

/** The body of a decision register outcome: the proposal, and once settled, the decisions. */
export const decisionRegisterSchema = v.pipe(
  v.object({
    summary: v.pipe(v.string(), v.trim(), v.maxLength(DECISION_PROSE_MAX)),
    items: v.pipe(v.array(decisionItemSchema), v.minLength(1), v.maxLength(DECISION_ITEMS_MAX)),
    /**
     * Questions the stage required that the proposal left out, recorded by the platform so the
     * person settling the register sees them rather than taking the register as complete.
     */
    unanswered: v.optional(v.array(itemId), []),
  }),
  v.check(
    (r) => new Set(r.items.map((i) => i.id)).size === r.items.length,
    'item ids must be unique',
  ),
)
export type DecisionRegister = v.InferOutput<typeof decisionRegisterSchema>

/** What a person sends to settle a register at the checkpoint: one choice per item. */
export const decisionRevisionSchema = v.object({
  decisions: v.array(v.object({ itemId, choice: required, note: v.optional(short) })),
})
export type DecisionRevision = v.InferOutput<typeof decisionRevisionSchema>

/** What the decider agent is handed. */
export interface DecisionBrief {
  brief: string
  /** Questions the stage requires answered. */
  questions: { id: string; question: string }[]
  /** The register an earlier, stopped dispatch of this task proposed, to continue from. */
  checkpoint?: DecisionRegister
  /**
   * The register this stage last recorded (the person's settlement when they settled one), for a
   * rerun to carry forward what the new evidence does not change.
   */
  prior?: DecisionRegister
}

function parsed<T>(schema: v.GenericSchema<unknown, T>, input: unknown): DefinitionParseResult<T> {
  const result = v.safeParse(schema, input)
  return result.success
    ? { ok: true, value: result.output }
    : { ok: false, issues: describeValibotIssues(result.issues) }
}

export const parseDecisionStageConfig = (input: unknown) => parsed(decisionStageConfigSchema, input)
export const parseDecisionRegister = (input: unknown) => parsed(decisionRegisterSchema, input)

/**
 * Settle a register with a person's choices. Every item must be settled exactly once; a choice need
 * not be one of the proposed options, since the person may decide otherwise.
 */
export function settleDecisionRegister(
  register: DecisionRegister,
  input: unknown,
  decidedBy: string | null,
  decidedAt: number,
): DefinitionParseResult<DecisionRegister> {
  const revision = parsed(decisionRevisionSchema, input)
  if (!revision.ok) return revision
  const issues: string[] = []
  const byItem = new Map<string, DecisionRevision['decisions'][number]>()
  for (const d of revision.value.decisions) {
    if (byItem.has(d.itemId)) issues.push(`${d.itemId}: decided more than once`)
    byItem.set(d.itemId, d)
  }
  const known = new Set(register.items.map((i) => i.id))
  for (const id of byItem.keys()) if (!known.has(id)) issues.push(`${id}: no such item`)
  for (const item of register.items) if (!byItem.has(item.id)) issues.push(`${item.id}: undecided`)
  if (issues.length) return { ok: false, issues }
  return {
    ok: true,
    value: {
      ...register,
      items: register.items.map((item) => {
        const d = byItem.get(item.id)!
        return {
          ...item,
          decision: {
            choice: d.choice,
            ...(d.note ? { note: d.note } : {}),
            decidedBy,
            decidedAt,
          },
        }
      }),
    },
  }
}

/** A register as Markdown, for a later stage's agent: each question with its decision or proposal. */
export function renderDecisionRegister(title: string, register: DecisionRegister): string {
  const lines = [`# ${title}`, '']
  if (register.summary) lines.push(register.summary, '')
  if (register.unanswered.length) {
    lines.push(`Required questions the proposal left out: ${register.unanswered.join(', ')}`, '')
  }
  for (const item of register.items) {
    lines.push(`## ${item.question}`, '')
    if (item.decision) {
      lines.push(`Decided: ${item.decision.choice}`)
      if (item.decision.note) lines.push(`Note: ${item.decision.note}`)
    } else {
      lines.push(`Not decided yet. Recommended: ${item.recommendation}`)
    }
    if (item.options.length) lines.push(`Options considered: ${item.options.join('; ')}`)
    if (item.rationale) lines.push(`Rationale: ${item.rationale}`)
    lines.push('')
  }
  return lines.join('\n')
}
