import { bugInvestigation } from '@cat-factory/agents'

// Pure rendering for the `bug-investigator` post-completion resolver: fold its STRUCTURED
// triage (`result.custom`, the `bugInvestigation` schema) into a prose Markdown digest that
// lands on `step.output`. Downstream steps read only `step.output` via `priorOutputs` (the
// estimator, repro-test and coder), so this digest is how the investigation reaches them; the
// raw structured object stays on `step.custom` for the `generic-structured` result view and for
// the clarity gate's own structured read. Returns `undefined` for an unparseable/empty result
// so the resolver leaves the agent's raw reply on `step.output` untouched.

/** Render a bug-investigator's structured triage into a human-readable digest, or undefined. */
export function renderInvestigationDigest(custom: unknown): string | undefined {
  const inv = bugInvestigation.safeParse(custom)
  if (!inv) return undefined
  const lines: string[] = []
  const bullets = (values: string[]): string[] =>
    values
      .map((v) => v.trim())
      .filter((v) => v.length > 0)
      .map((v) => `- ${v}`)

  if (inv.summary?.trim()) lines.push('## Investigation summary', '', inv.summary.trim())

  const hypotheses = bullets(inv.rootCauseHypotheses)
  if (hypotheses.length) lines.push('', '## Candidate root causes (ranked)', '', ...hypotheses)

  const repos = inv.affectedRepos
    .filter((r) => r.repo.trim().length > 0 || r.paths.length > 0)
    .map((r) => {
      const paths = r.paths.map((p) => p.trim()).filter((p) => p.length > 0)
      const head = `- **${r.repo.trim() || '(unnamed repo)'}**${r.rationale?.trim() ? ` — ${r.rationale.trim()}` : ''}`
      return paths.length ? `${head}\n${paths.map((p) => `  - \`${p}\``).join('\n')}` : head
    })
  if (repos.length) lines.push('', '## Affected repositories', '', ...repos)

  const repros = bullets(inv.suggestedReproductions)
  if (repros.length) lines.push('', '## Suggested reproductions', '', ...repros)

  if (inv.clarity === 'needs_clarification') {
    const questions = bullets(inv.questions)
    if (questions.length) lines.push('', '## Open questions for the reporter', '', ...questions)
  }

  const body = lines.join('\n').trim()
  return body.length > 0 ? body : undefined
}
