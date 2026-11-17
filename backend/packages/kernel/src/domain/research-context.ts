import {
  type FindingsRevisionBody,
  type ProjectOutcome,
  type QuestionFinding,
  type ResearchProjectView,
  type ResearchSpec,
  researchProjectView,
} from '@cat-factory/contracts'
import type { ProjectContextRendering } from './project-kind-module.js'

// Research findings as context for another agent: what a task that links a research project, or a
// later stage that reads a research stage, sees of them. The folded findings, one summary line and
// one coverage line for the prompt's index, and the full findings as Markdown for the file the
// agent opens.

/** Where the questions came from: their spec, and a line naming it (null to name nothing). */
export interface ResearchContextSource {
  spec: ResearchSpec | null
  label: string | null
}

/** Research findings folded against the questions they answer, rendered for another agent. */
export function renderResearchContext(
  source: ResearchContextSource,
  outcomes: ReadonlyArray<ProjectOutcome<FindingsRevisionBody>>,
): ProjectContextRendering {
  const topics = source.spec?.topics ?? []
  const view = researchProjectView(topics, outcomes)
  const { total } = view.coverage
  const count = total.answered + total.partial + total.blocked + total.unanswered
  const coverage =
    `${total.answered} of ${count} questions answered, ${total.partial} partial, ` +
    `${total.blocked} blocked, ${total.unanswered} unanswered`
  const lines: string[] = []
  if (source.label) lines.push(source.label)
  lines.push(`Coverage: ${coverage}`, '')
  if (view.summary) lines.push('## Summary', '', view.summary, '')
  const answerOf = (id: string) => view.findings.find((f) => f.finding.questionId === id)?.finding
  for (const topic of topics) {
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
