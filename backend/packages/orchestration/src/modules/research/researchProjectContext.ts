import {
  type FindingsRevision,
  type FoldedFindings,
  type Project,
  type QuestionFinding,
  type ResearchDefinition,
  type ResearchProject,
  foldFindings,
  isAdhocQuestionId,
  researchCoverage,
} from '@cat-factory/contracts'
import {
  type FindingsRevisionRepository,
  type ResearchDefinitionSource,
  type ResearchProjectRepository,
  redactSecrets,
} from '@cat-factory/kernel'
import type { ProjectContextContributor, ProjectContextEntry } from '../projects/projectContext.js'
import { adhocQuestionsOf } from './ResearchProjectViews.js'
import type { ResearchFindingsStore } from './ResearchFindingsStore.js'

export interface ResearchProjectContextDeps {
  pins: Pick<ResearchProjectRepository, 'listByProjectIds'>
  revisions: Pick<FindingsRevisionRepository, 'projectsWithRevisions'>
  definitions: ResearchDefinitionSource
  findings: Pick<ResearchFindingsStore, 'listRevisionsOfProjects'>
}

/**
 * A research project as linked context: its current findings folded across every revision. A
 * project has a result once it holds one revision. An offloaded body that cannot be read throws
 * `findings_body_unavailable` out of the store, which breaks the run naming the project.
 */
export function researchProjectContext(
  deps: ResearchProjectContextDeps,
): ProjectContextContributor {
  return {
    async withResult(projects) {
      return new Set(await deps.revisions.projectsWithRevisions(projects.map((p) => p.id)))
    },
    async render(projects) {
      const [pins, revisions, definitions] = await Promise.all([
        deps.pins.listByProjectIds(projects.map((p) => p.id)),
        deps.findings.listRevisionsOfProjects(projects),
        definitionsByAccount(deps.definitions, projects),
      ])
      const pinOf = new Map(pins.map((pin) => [pin.projectId, pin] as const))
      const rendered = new Map<string, ProjectContextEntry>()
      for (const project of projects) {
        const pin = pinOf.get(project.id)
        const definition = pin
          ? (definitions.get(
              definitionKey(project.accountId, pin.definitionKey, pin.definitionVersion),
            ) ?? null)
          : null
        rendered.set(
          project.id,
          renderEntry(pin ?? null, definition, revisions.get(project.id) ?? []),
        )
      }
      return rendered
    },
  }
}

/** Every definition the projects' accounts can pin, one list read per account. */
async function definitionsByAccount(
  source: ResearchDefinitionSource,
  projects: readonly Project[],
): Promise<Map<string, ResearchDefinition>> {
  const accounts = [...new Set(projects.map((p) => p.accountId))]
  const lists = await Promise.all(accounts.map((account) => source.list(account ?? '')))
  const byKey = new Map<string, ResearchDefinition>()
  accounts.forEach((account, i) => {
    for (const resolved of lists[i] ?? []) {
      const d = resolved.definition
      byKey.set(definitionKey(account, d.key, d.version), d)
    }
  })
  return byKey
}

function definitionKey(account: string | null, key: string, version: number): string {
  return `${account ?? ''}\u0000${key}\u0000${version}`
}

function renderEntry(
  pin: ResearchProject | null,
  definition: ResearchDefinition | null,
  revisions: readonly FindingsRevision[],
): ProjectContextEntry {
  const folded = foldFindings(revisions)
  const adhoc = adhocQuestionsOf(revisions)
  const adhocIds = [
    ...new Set([
      ...adhoc.map((q) => q.id),
      ...Object.keys(folded.byQuestion).filter(isAdhocQuestionId),
    ]),
  ]
  const coverage = researchCoverage(definition?.topics ?? [], adhocIds, folded)
  const total = Object.values(coverage.total).reduce((sum, n) => sum + n, 0)
  const coverageLine =
    `${coverage.total.answered} of ${total} questions answered, ${coverage.total.partial} partial, ` +
    `${coverage.total.blocked} blocked, ${coverage.total.unanswered} unanswered`
  const latest = [...revisions].sort((a, b) => b.seq - a.seq)[0]
  const summary = folded.summary.split('\n')[0]?.trim() || 'Research findings.'
  return {
    summary: redactSecrets(summary) ?? '',
    coverage: coverageLine,
    body: redactSecrets(renderBody(pin, definition, folded, adhoc, coverageLine)) ?? '',
    revision: latest ? { id: latest.id, seq: latest.seq } : null,
  }
}

function renderBody(
  pin: ResearchProject | null,
  definition: ResearchDefinition | null,
  folded: FoldedFindings,
  adhoc: readonly { id: string; question: string }[],
  coverageLine: string,
): string {
  const lines: string[] = []
  if (pin) lines.push(`Research definition: ${pin.definitionKey} v${pin.definitionVersion}`)
  lines.push(`Coverage: ${coverageLine}`, '')
  if (folded.summary) lines.push('## Summary', '', folded.summary, '')
  for (const topic of definition?.topics ?? []) {
    lines.push(`## ${topic.title}`, '')
    for (const question of topic.questions)
      lines.push(...renderQuestion(question.question, folded.byQuestion[question.id]?.finding))
  }
  if (adhoc.length) {
    lines.push('## Ad-hoc questions', '')
    for (const question of adhoc)
      lines.push(...renderQuestion(question.question, folded.byQuestion[question.id]?.finding))
  }
  if (folded.learnings.length) {
    lines.push('## Learnings', '')
    for (const learning of folded.learnings)
      lines.push(`- ${learning.title}${learning.detail ? `: ${learning.detail}` : ''}`)
    lines.push('')
  }
  return lines.join('\n')
}

function renderQuestion(question: string, finding: QuestionFinding | undefined): string[] {
  if (!finding) return [`### ${question}`, '', 'Status: unanswered', '']
  const lines = [
    `### ${question}`,
    '',
    `Status: ${finding.status}, confidence ${finding.confidence}`,
    '',
  ]
  if (finding.answer) lines.push(finding.answer, '')
  if (finding.blockedOn)
    lines.push(`Blocked on the credential \`${finding.blockedOn.credentialKey}\`.`, '')
  for (const caveat of finding.caveats) lines.push(`- Caveat: ${caveat}`)
  for (const evidence of finding.evidence) {
    if (evidence.kind === 'url') lines.push(`- Evidence: ${evidence.url}`)
    if (evidence.kind === 'repo-path')
      lines.push(`- Evidence: ${evidence.path} (repository ${evidence.repoId})`)
  }
  if (finding.caveats.length || finding.evidence.length) lines.push('')
  return lines
}
