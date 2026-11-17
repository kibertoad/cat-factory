import {
  DEFAULT_OUTCOME_STREAM,
  DECISION_REGISTER_SCHEMA_VERSION,
  DECISIONS_TASK_TYPE,
  PROJECT_DECIDER_AGENT_KIND,
  type DecisionBrief,
  type DecisionRegister,
  type DecisionStageConfig,
  decisionRegisterSchema,
  parseDecisionRegister,
  parseDecisionStageConfig,
  renderDecisionRegister,
  settleDecisionRegister,
} from '@cat-factory/contracts'
import { ValidationError } from './errors.js'
import type { ProjectTaskHandler, ProjectTaskInput } from './project-kind-module.js'

// ---------------------------------------------------------------------------
// The handler of the built-in `decisions` task type: a decision register. Its agent proposes the
// decisions a body of work needs from the stages it reads; a person settles every item at the
// stage's checkpoint (the revision is REQUIRED), and the settled register is what later stages
// read. Any project kind may offer it: the platform ships the mechanism, a deployment's kind lists
// it beside its other handlers. Design: `docs/initiatives/staged-project-definitions.md`.
// ---------------------------------------------------------------------------

function configOf(input: ProjectTaskInput<DecisionRegister>): DecisionStageConfig {
  if (!input.stage) {
    throw new ValidationError('A decision task runs only as a stage of a staged definition', {
      reason: 'project_task_type_needs_stage',
      taskType: DECISIONS_TASK_TYPE,
    })
  }
  const parsed = parseDecisionStageConfig(input.stage.config)
  if (parsed.ok) return parsed.value
  throw new ValidationError(`Decision stage '${input.stage.id}' carries no readable config`, {
    reason: 'project_definition_invalid',
    stageId: input.stage.id,
    problems: parsed.issues,
  })
}

/**
 * The register as proposed: every decision cleared, whatever the agent wrote into it, and every
 * required question it left out named.
 */
function proposal(register: DecisionRegister, config: DecisionStageConfig): DecisionRegister {
  const present = new Set(register.items.map((i) => i.id))
  return {
    ...register,
    items: register.items.map((item) => ({ ...item, decision: null })),
    unanswered: config.questions.map((q) => q.id).filter((id) => !present.has(id)),
  }
}

/** Two proposals folded by item id, the later one's items winning. */
function mergeRegisters(earlier: DecisionRegister, later: DecisionRegister): DecisionRegister {
  const byId = new Map(earlier.items.map((i) => [i.id, i] as const))
  for (const item of later.items) byId.set(item.id, item)
  return { summary: later.summary || earlier.summary, items: [...byId.values()], unanswered: [] }
}

function describe(register: DecisionRegister, seq: number): string {
  const decided = register.items.filter((i) => i.decision).length
  const missing = register.unanswered.length
    ? ` It left out required question(s): ${register.unanswered.join(', ')}.`
    : ''
  const head =
    decided === register.items.length
      ? `Decision register ${seq}: all ${decided} item(s) settled.`
      : `Proposed decision register ${seq} with ${register.items.length} item(s), awaiting a ` +
        `person to settle them at the checkpoint.${missing}`
  return register.summary ? `${head}\n\n${register.summary}` : head
}

export const decisionTaskHandler: ProjectTaskHandler<DecisionRegister> = {
  taskType: DECISIONS_TASK_TYPE,
  agentKind: PROJECT_DECIDER_AGENT_KIND,
  outcomeSchemaVersion: DECISION_REGISTER_SCHEMA_VERSION,

  parseOutcome: (schemaVersion, value) => {
    if (schemaVersion !== DECISION_REGISTER_SCHEMA_VERSION) return undefined
    const parsed = parseDecisionRegister(value)
    return parsed.ok ? parsed.value : undefined
  },

  planTask(input) {
    // The plan carries the questions the stage required, so `finish` can name any left out.
    return { intent: 'propose', stream: DEFAULT_OUTCOME_STREAM, plan: configOf(input) }
  },

  brief(input): DecisionBrief {
    const config = configOf(input)
    const prior = input.outcomes.at(-1)?.body
    return {
      brief: config.brief,
      questions: config.questions,
      ...(prior ? { prior } : {}),
      ...(input.checkpoint ? { checkpoint: input.checkpoint } : {}),
    }
  },

  mergeCheckpoint: mergeRegisters,

  finish({ plan, seq, reply, checkpoint }) {
    const planned = parseDecisionStageConfig(plan)
    // A plan this build cannot read names no required question rather than inventing some.
    const config = planned.ok ? planned.value : { brief: '', questions: [] }
    const merged = checkpoint ? mergeRegisters(checkpoint, reply) : reply
    const body = proposal(merged, config)
    return { body, output: describe(body, seq) }
  },

  describe: ({ seq, body }) => describe(body, seq),

  artifactRefs: () => [],

  parseConfig: parseDecisionStageConfig,

  renderContext: ({ stage, outcomes }) => {
    const register = outcomes.at(-1)?.body
    if (!register) {
      const note = `Decision stage '${stage.title}' has no register yet.`
      return { summary: note, coverage: 'no register', body: note }
    }
    const decided = register.items.filter((i) => i.decision).length
    return {
      summary: register.summary.split('\n')[0]?.trim() || `Decisions of ${stage.title}.`,
      coverage: `${decided} of ${register.items.length} decisions settled`,
      body: renderDecisionRegister(`Decisions: ${stage.title}`, register),
    }
  },

  checkpointRevision: {
    required: true,
    revise: ({ body, revision, decidedBy, decidedAt }) =>
      settleDecisionRegister(body, revision, decidedBy, decidedAt),
  },

  schemas: { outcome: decisionRegisterSchema },
}
