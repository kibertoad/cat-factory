import {
  DECISION_REGISTER_SCHEMA_VERSION,
  DECISIONS_TASK_TYPE,
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

/** The agent kind a decision task dispatches. */
export const PROJECT_DECIDER_AGENT_KIND = 'project-decider'

function configOf(input: ProjectTaskInput<DecisionRegister>): DecisionStageConfig {
  if (!input.stage) {
    throw new ValidationError('A decision task runs as a stage of a staged project', {
      reason: 'project_task_has_no_stage',
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

/** The register as proposed: every decision cleared, whatever the agent wrote into it. */
function proposal(register: DecisionRegister): DecisionRegister {
  return { ...register, items: register.items.map((item) => ({ ...item, decision: null })) }
}

function describe(register: DecisionRegister, seq: number): string {
  const decided = register.items.filter((i) => i.decision).length
  const head =
    decided === register.items.length
      ? `Decision register ${seq}: all ${decided} item(s) settled.`
      : `Proposed decision register ${seq} with ${register.items.length} item(s), awaiting a ` +
        'person to settle them at the checkpoint.'
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
    configOf(input)
    return { intent: 'propose', stream: 'main', plan: {} }
  },

  brief(input): DecisionBrief {
    const config = configOf(input)
    return {
      brief: config.brief,
      questions: config.questions,
      ...(input.checkpoint ? { checkpoint: input.checkpoint } : {}),
    }
  },

  mergeCheckpoint: (_earlier, later) => later,

  finish({ seq, reply }) {
    const body = proposal(reply)
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
