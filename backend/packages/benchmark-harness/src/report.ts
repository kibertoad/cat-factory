import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { rubricFor, weightedTotal } from './rubrics'
import type { CandidateResult, CellGrade, GradesFile, TaskType } from './types'

// Folds the arbiter skill's grades.json back into the candidate results and
// renders the final committed report (report.json + report.md).

export interface ReportRow {
  id: string
  task: TaskType
  model: string
  prompt: string
  variant: string
  fixtureId: string
  latencyMs: number
  inputTokens?: number
  outputTokens?: number
  costEur?: number
  error?: string
  score?: number
  scores?: Record<string, number>
  notes?: string
}

function buildRows(candidates: CandidateResult[], grades: CellGrade[]): ReportRow[] {
  const byId = new Map(grades.map((g) => [g.id, g]))
  return candidates.map((c) => {
    const grade = byId.get(c.id)
    const scores = grade ? Object.fromEntries(grade.scores.map((s) => [s.key, s.score])) : undefined
    return {
      id: c.id,
      task: c.cell.task,
      model: c.cell.model,
      prompt: c.cell.prompt,
      variant: c.cell.variant,
      fixtureId: c.cell.fixtureId,
      latencyMs: c.latencyMs,
      inputTokens: c.usage?.inputTokens,
      outputTokens: c.usage?.outputTokens,
      costEur: c.costEur,
      error: c.error,
      score: grade
        ? grade.weightedTotal ?? weightedTotal(c.cell.task, grade.scores)
        : undefined,
      scores,
      notes: grade?.notes,
    }
  })
}

function fmt(n: number | undefined, digits = 2): string {
  return typeof n === 'number' ? n.toFixed(digits) : '—'
}

function renderTaskTable(task: TaskType, rows: ReportRow[]): string {
  const dims = rubricFor(task).dimensions
  const header = ['Model', 'Prompt', 'Score', ...dims.map((d) => d.label), 'Latency (ms)', 'Cost (€)']
  const sep = header.map(() => '---')
  const body = rows
    .slice()
    .sort((a, b) => (b.score ?? -1) - (a.score ?? -1))
    .map((r) =>
      [
        r.model,
        r.prompt,
        r.error ? '⚠ failed' : fmt(r.score),
        ...dims.map((d) => fmt(r.scores?.[d.key], 0)),
        String(r.latencyMs),
        fmt(r.costEur, 4),
      ].join(' | '),
    )
  return [
    `### ${task}`,
    '',
    `| ${header.join(' | ')} |`,
    `| ${sep.join(' | ')} |`,
    ...body.map((line) => `| ${line} |`),
    '',
  ].join('\n')
}

function renderReportMd(runId: string, rows: ReportRow[]): string {
  const tasks = [...new Set(rows.map((r) => r.task))]
  const graded = rows.filter((r) => typeof r.score === 'number').length
  return [
    `# Benchmark report — \`${runId}\``,
    '',
    `${rows.length} cells, ${graded} graded. Scores are the weighted mean of rubric dimensions (1–5).`,
    'Each row records the exact model and prompt version.',
    '',
    ...tasks.map((task) => renderTaskTable(task, rows.filter((r) => r.task === task))),
  ].join('\n')
}

/** Merge `grades.json` into the candidates and write `report.json` + `report.md`. */
export async function buildReport(outDir: string, runId: string): Promise<ReportRow[]> {
  const candidates = JSON.parse(
    await readFile(join(outDir, 'candidates.json'), 'utf8'),
  ) as CandidateResult[]
  let grades: CellGrade[] = []
  try {
    const file = JSON.parse(await readFile(join(outDir, 'grades.json'), 'utf8')) as GradesFile
    grades = file.grades ?? []
  } catch {
    // No grades yet — produce a candidates-only report.
  }
  const rows = buildRows(candidates, grades)
  await writeFile(join(outDir, 'report.json'), `${JSON.stringify({ runId, rows }, null, 2)}\n`, 'utf8')
  await writeFile(join(outDir, 'report.md'), renderReportMd(runId, rows), 'utf8')
  return rows
}
