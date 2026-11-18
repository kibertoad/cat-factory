import {
  DEFAULT_OUTCOME_STREAM,
  PROJECT_WRITER_AGENT_KIND,
  WRITEUP_SCHEMA_VERSION,
  WRITEUP_TASK_TYPE,
  type Writeup,
  type WriteupBrief,
  type WriteupStageConfig,
  parseWriteup,
  parseWriteupStageConfig,
  settleWriteup,
  writeupSchema,
} from '@cat-factory/contracts'
import { ValidationError } from './errors.js'
import type { ProjectTaskHandler, ProjectTaskInput } from './project-kind-module.js'

// ---------------------------------------------------------------------------
// The handler of the built-in `writeup` task type: a document stage. Its agent composes the
// results of the stages it reads into one Markdown document referencing their artifacts; the
// platform drops an artifact no result it read holds and names the outline sections the document
// lacks. Any project kind may offer it beside its own handlers. Design:
// `backend/docs/adr/0070-staged-project-definitions.md`.
// ---------------------------------------------------------------------------

/** What a planned writeup carries: its config, and the artifacts it may reference. */
interface WriteupPlan {
  config: WriteupStageConfig
  artifacts: string[]
}

function configOf(input: ProjectTaskInput<Writeup>): WriteupStageConfig {
  if (!input.stage) {
    throw new ValidationError('A writeup task runs only as a stage of a staged definition', {
      reason: 'project_task_type_needs_stage',
      taskType: WRITEUP_TASK_TYPE,
    })
  }
  const parsed = parseWriteupStageConfig(input.stage.config)
  if (parsed.ok) return parsed.value
  throw new ValidationError(`Writeup stage '${input.stage.id}' carries no readable config`, {
    reason: 'project_definition_invalid',
    stageId: input.stage.id,
    problems: parsed.issues,
  })
}

/** A plan this build can read, or one that names no outline and allows no artifact. */
function planOf(plan: unknown): WriteupPlan {
  const p = plan as Partial<WriteupPlan> | null
  const config = parseWriteupStageConfig(p?.config)
  return {
    config: config.ok ? config.value : { brief: '', outline: [] },
    artifacts: Array.isArray(p?.artifacts) ? p.artifacts.filter((a) => typeof a === 'string') : [],
  }
}

function describe(doc: Writeup, seq: number): string {
  const parts = [`Writeup ${seq}: "${doc.title}".`]
  if (doc.missingSections.length) {
    parts.push(`It has no section for: ${doc.missingSections.join(', ')}.`)
  }
  if (doc.droppedArtifacts.length) {
    parts.push(
      `${doc.droppedArtifacts.length} artifact reference(s) no result it read holds were left out.`,
    )
  }
  return doc.summary ? `${parts.join(' ')}\n\n${doc.summary}` : parts.join(' ')
}

export const writeupTaskHandler: ProjectTaskHandler<Writeup> = {
  taskType: WRITEUP_TASK_TYPE,
  agentKind: PROJECT_WRITER_AGENT_KIND,
  outcomeSchemaVersion: WRITEUP_SCHEMA_VERSION,

  parseOutcome: (schemaVersion, value) => {
    if (schemaVersion !== WRITEUP_SCHEMA_VERSION) return undefined
    const parsed = parseWriteup(value)
    return parsed.ok ? parsed.value : undefined
  },

  planTask(input) {
    const plan: WriteupPlan = {
      config: configOf(input),
      artifacts: [...(input.upstreamArtifacts ?? [])],
    }
    return { intent: 'draft', stream: DEFAULT_OUTCOME_STREAM, plan }
  },

  brief(input): WriteupBrief {
    // The stage's own config, refused when unreadable; the plan only fixes the artifacts.
    const config = configOf(input)
    const { artifacts } = planOf(input.plan)
    const prior = input.outcomes.at(-1)?.body
    return {
      brief: config.brief,
      outline: config.outline,
      artifacts,
      ...(prior ? { prior } : {}),
      ...(input.checkpoint ? { checkpoint: input.checkpoint } : {}),
    }
  },

  mergeCheckpoint: (_earlier, later) => later,

  finish({ plan, seq, reply }) {
    const { config, artifacts } = planOf(plan)
    const body = settleWriteup(reply, config.outline, artifacts)
    return { body, output: describe(body, seq) }
  },

  describe: ({ seq, body }) => describe(body, seq),

  artifactRefs: (doc) => doc.artifacts.map((a) => a.ref),

  parseConfig: parseWriteupStageConfig,

  renderContext: ({ stage, outcomes }) => {
    const doc = outcomes.at(-1)?.body
    if (!doc) {
      const note = `Writeup stage '${stage.title}' has no document yet.`
      return { summary: note, coverage: 'no document', body: note }
    }
    const missing = doc.missingSections.length
      ? `, missing ${doc.missingSections.length} outline section(s)`
      : ''
    return {
      summary: doc.summary.split('\n')[0]?.trim() || `The ${stage.title} document.`,
      coverage: `${doc.artifacts.length} artifact(s) referenced${missing}`,
      body: [`# ${doc.title}`, '', doc.markdown].join('\n'),
    }
  },

  // The document is composed from the results of the stages it reads.
  stageRequires: { consumes: true },

  schemas: { outcome: writeupSchema },
}
