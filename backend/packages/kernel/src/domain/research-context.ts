import {
  type FindingsRevisionBody,
  type QuestionFinding,
  type ResearchProjectView,
  parseResearchDefinition,
  researchProjectView,
} from '@cat-factory/contracts'
import type { ProjectContextRendering, ProjectViewInput } from './project-kind-module.js'

// The research kind's linked context: what a task that links a research project reads of it. The
// folded findings, one summary line and one coverage line for the prompt's index, and the full
// findings as Markdown for the file the agent opens.

/** A research project's findings rendered for an agent that reads them as linked context. */
export function renderResearchContext(
  input: ProjectViewInput<FindingsRevisionBody>,
): ProjectContextRendering {
  const parsed = input.definition ? parseResearchDefinition(input.definition) : undefined
  const definition = parsed?.ok ? parsed.value : null
  const view = researchProjectView(definition?.spec.topics ?? [], input.outcomes)
  const { total } = view.coverage
  const count = total.answered + total.partial + total.blocked + total.unanswered
  const coverage =
    `${total.answered} of ${count} questions answered, ${total.partial} partial, ` +
    `${total.blocked} blocked, ${total.unanswered} unanswered`
  const lines: string[] = []
  if (definition) lines.push(`Research definition: ${definition.key} v${definition.version}`)
  lines.push(`Coverage: ${coverage}`, '')
  if (view.summary) lines.push('## Summary', '', view.summary, '')
  const answerOf = (id: string) => view.findings.find((f) => f.finding.questionId === id)?.finding
  for (const topic of definition?.spec.topics ?? []) {
    lines.push(`## ${topic.title}`, '')
    for (const question of topic.questions) {
      lines.push(...renderQuestion(question.question, answerOf(question.id)))
    }
  }
  if (view.adhocQuestions.length) {
    lines.push('## Ad-hoc questions', '')
    for (const question of view.adhocQuestions) {
      lines.push(...renderQuestion(question.question, answerOf(question.id)))
    }
  }
  lines.push(...renderLearnings(view))
  return {
    summary: view.summary.split('\n')[0]?.trim() || 'Research findings.',
    coverage,
    body: lines.join('\n'),
  }
}

function renderLearnings(view: ResearchProjectView): string[] {
  if (!view.learnings.length) return []
  return [
    '## Learnings',
    '',
    ...view.learnings.map((l) => `- ${l.title}${l.detail ? `: ${l.detail}` : ''}`),
    '',
  ]
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
  if (finding.blockedOn) {
    lines.push(`Blocked on the credential \`${finding.blockedOn.credentialKey}\`.`, '')
  }
  for (const caveat of finding.caveats) lines.push(`- Caveat: ${caveat}`)
  for (const evidence of finding.evidence) {
    if (evidence.kind === 'url') lines.push(`- Evidence: ${evidence.url}`)
    if (evidence.kind === 'repo-path') {
      lines.push(`- Evidence: ${evidence.path} (repository ${evidence.repoId})`)
    }
  }
  if (finding.caveats.length || finding.evidence.length) lines.push('')
  return lines
}
