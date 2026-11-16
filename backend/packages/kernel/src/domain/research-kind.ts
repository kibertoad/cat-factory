import {
  type AdhocQuestion,
  type FindingsRevisionBody,
  type FoldedFindings,
  type ProjectKindDescriptor,
  RESEARCH_KIND,
  RESEARCH_OUTCOME_SCHEMA_VERSION,
  type ResearchBrief,
  type ResearchMode,
  type ResearchSpec,
  type ResearchTaskPlan,
  DEFAULT_OUTCOME_STREAM,
  adhocQuestionId,
  findingsArtifactRefs,
  foldFindings,
  parseFindingsRevisionBody,
  parseResearchDefinition,
  parseResearchTaskPlan,
  researchSpecValidator,
} from '@cat-factory/contracts'
import { ValidationError } from './errors.js'
import type { ProjectKindModule, ProjectTaskInput } from './project-kind-module.js'

// ---------------------------------------------------------------------------
// The RESEARCH project kind the platform ships: its descriptor and its module. A research
// project pins a research definition (topics of questions about a vendor), and each `research`
// task answers some of those questions and records one findings revision on the project's
// `main` stream. Everything here is the kind's own; the engine reaches it only through the
// `ProjectKindModule` interface. Design: `docs/initiatives/research-projects.md`.
// ---------------------------------------------------------------------------

/** The agent kind a research task dispatches. */
export const PROJECT_RESEARCHER_AGENT_KIND = 'project-researcher'

/** The descriptor the board offers: research tasks that read linked repos and write none. */
export const RESEARCH_PROJECT_KIND: ProjectKindDescriptor = {
  id: RESEARCH_KIND,
  label: 'Research',
  description: 'Research a vendor or system against a research definition and keep the findings.',
  definition: 'required',
  taskTypes: [
    { taskType: 'research', repoAccess: 'linked-read-only', defaultPipelineId: 'pl_research' },
  ],
}

function specOf(input: ProjectTaskInput<FindingsRevisionBody>): ResearchSpec {
  const parsed = input.definition ? parseResearchDefinition(input.definition) : undefined
  if (!parsed?.ok) {
    throw new ValidationError('A research task needs its project to pin a research definition', {
      reason: 'project_not_pinned',
    })
  }
  return parsed.value.spec
}

function planOf(plan: unknown): ResearchTaskPlan {
  const parsed = parseResearchTaskPlan(plan)
  if (!parsed) throw new Error('A research step carries no readable plan')
  return parsed
}

function fold(input: ProjectTaskInput<FindingsRevisionBody>): FoldedFindings {
  return foldFindings(input.outcomes)
}

/**
 * The questions a task of `mode` asks: every definition question (`initial`), the ones no
 * revision has touched (`extend`), the partial or blocked ones (`clarify`), or the answered ones
 * (`refresh`). Past `initial`, the ad-hoc questions earlier tasks added are candidates beside the
 * definition's. `named` narrows `clarify` and `refresh` to the questions a person picked.
 */
export function selectQuestionIds(
  spec: ResearchSpec,
  mode: ResearchMode,
  folded: FoldedFindings,
  named?: readonly string[],
  earlierAdhoc: readonly string[] = [],
): string[] {
  const fromDefinition = spec.topics.flatMap((topic) => topic.questions.map((q) => q.id))
  const all = [...fromDefinition, ...earlierAdhoc]
  const status = (id: string) => folded.byQuestion[id]?.finding.status
  switch (mode) {
    case 'initial':
      return fromDefinition
    case 'extend':
      return all.filter((id) => status(id) === undefined)
    case 'clarify':
      return named?.length
        ? all.filter((id) => named.includes(id))
        : all.filter((id) => status(id) === 'partial' || status(id) === 'blocked')
    case 'refresh':
      return named?.length
        ? all.filter((id) => named.includes(id))
        : all.filter((id) => status(id) !== undefined)
    default:
      return unknownMode(mode)
  }
}

function unknownMode(mode: never): never {
  throw new Error(`unknown research mode: ${String(mode)}`)
}

/** A later body's findings replace an earlier one's by question id; learnings accumulate. */
export function mergeFindingsBodies(
  earlier: FindingsRevisionBody,
  later: FindingsRevisionBody,
): FindingsRevisionBody {
  const byId = new Map(earlier.findings.map((f) => [f.questionId, f]))
  for (const finding of later.findings) byId.set(finding.questionId, finding)
  const titles = new Set(later.learnings.map((l) => l.title))
  return {
    summary: later.summary || earlier.summary,
    findings: [...byId.values()],
    learnings: [...earlier.learnings.filter((l) => !titles.has(l.title)), ...later.learnings],
    adhocQuestions: later.adhocQuestions,
  }
}

/** The ad-hoc questions earlier revisions answered, the latest text for each id winning. */
function earlierAdhocQuestions(
  outcomes: ProjectTaskInput<FindingsRevisionBody>['outcomes'],
): AdhocQuestion[] {
  const byId = new Map<string, AdhocQuestion>()
  for (const outcome of [...outcomes].sort((a, b) => a.seq - b.seq)) {
    for (const question of outcome.body.adhocQuestions) byId.set(question.id, question)
  }
  return [...byId.values()]
}

/** The step's readable output: the coverage a revision recorded, and what it dropped. */
function renderRevision(
  body: FindingsRevisionBody,
  plan: ResearchTaskPlan,
  seq: number,
  dropped: readonly string[],
): string {
  const counts = { answered: 0, partial: 0, unanswered: 0, blocked: 0 }
  for (const finding of body.findings) counts[finding.status] += 1
  const missing = plan.questionIds.length - body.findings.length
  const lines = [
    `Recorded findings revision ${seq} (${plan.mode}) for ${plan.questionIds.length} question(s): ` +
      `${counts.answered} answered, ${counts.partial} partial, ${counts.unanswered} unanswered, ` +
      `${counts.blocked} blocked${missing > 0 ? `, ${missing} not reported` : ''}.`,
  ]
  if (dropped.length) {
    lines.push(`Dropped answers to questions this task was not asked: ${dropped.join(', ')}.`)
  }
  if (body.summary) lines.push('', body.summary)
  return lines.join('\n')
}

export const researchKindModule: ProjectKindModule<FindingsRevisionBody> = {
  kind: RESEARCH_KIND,
  agentKind: PROJECT_RESEARCHER_AGENT_KIND,
  outcomeSchemaVersion: RESEARCH_OUTCOME_SCHEMA_VERSION,
  parseSpec: researchSpecValidator.parseSpec,

  parseOutcome: (schemaVersion, value) =>
    schemaVersion === RESEARCH_OUTCOME_SCHEMA_VERSION
      ? parseFindingsRevisionBody(value)
      : undefined,

  planTask(input) {
    const spec = specOf(input)
    const folded = fold(input)
    const fields = input.task.taskTypeFields
    const mode = fields?.researchMode ?? (input.outcomes.length ? 'extend' : 'initial')
    const own = (fields?.researchQuestions ?? []).map((question, i) => ({
      id: adhocQuestionId(input.task.id, i + 1),
      question,
    }))
    const earlier = earlierAdhocQuestions(input.outcomes)
    const selected = selectQuestionIds(
      spec,
      mode,
      folded,
      fields?.researchQuestionIds,
      earlier.map((q) => q.id),
    )
    const adhocQuestions = [...earlier.filter((q) => selected.includes(q.id)), ...own]
    const questionIds = [...selected, ...own.map((q) => q.id)]
    if (questionIds.length === 0) {
      throw new ValidationError(`A '${mode}' research task has no question left to ask`, {
        reason: 'research_nothing_to_ask',
        mode,
      })
    }
    const plan: ResearchTaskPlan = { mode, questionIds, adhocQuestions }
    return { intent: mode, stream: DEFAULT_OUTCOME_STREAM, plan }
  },

  brief(input): ResearchBrief {
    const spec = specOf(input)
    const plan = planOf(input.plan)
    const folded = fold(input)
    const byId = new Map(
      spec.topics.flatMap((topic) =>
        topic.questions.map((q) => [q.id, { topic: topic.title, question: q }] as const),
      ),
    )
    const adhoc = new Map((plan.adhocQuestions ?? []).map((q) => [q.id, q.question]))
    const questions = plan.questionIds.flatMap((id) => {
      const known = byId.get(id)
      if (known) {
        return [
          {
            id,
            topic: known.topic,
            question: known.question.question,
            ...(known.question.answerHint ? { answerHint: known.question.answerHint } : {}),
          },
        ]
      }
      const text = adhoc.get(id)
      return text ? [{ id, topic: 'Added for this task', question: text }] : []
    })
    const priorFindings = plan.questionIds.flatMap((id) => {
      const current = folded.byQuestion[id]
      return current
        ? [{ questionId: id, status: current.finding.status, answer: current.finding.answer }]
        : []
    })
    return {
      mode: plan.mode,
      brief: spec.brief,
      questions,
      priorFindings,
      ...(input.checkpoint ? { checkpoint: input.checkpoint } : {}),
    }
  },

  mergeCheckpoint: mergeFindingsBodies,

  finish({ plan: rawPlan, seq, reply, checkpoint }) {
    const plan = planOf(rawPlan)
    const merged = checkpoint ? mergeFindingsBodies(checkpoint, reply) : reply
    const asked = new Set(plan.questionIds)
    const dropped = merged.findings.filter((f) => !asked.has(f.questionId)).map((f) => f.questionId)
    const body: FindingsRevisionBody = {
      ...merged,
      findings: merged.findings.filter((f) => asked.has(f.questionId)),
      adhocQuestions: plan.adhocQuestions ?? [],
    }
    return { body, output: renderRevision(body, plan, seq, dropped) }
  },

  describe: ({ plan, seq, body }) => renderRevision(body, planOf(plan), seq, []),

  artifactRefs: findingsArtifactRefs,

  definitionSummary: (definition) => {
    const parsed = parseResearchDefinition(definition)
    return parsed.ok ? parsed.value.spec.brief : definition.title
  },
}
