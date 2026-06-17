import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { BenchmarkConfig } from './config'
import { rubricFor } from './rubrics'
import type { CandidateResult } from './types'

// Writes the run's machine artifacts and the per-cell grading folder the Claude
// arbiter skill consumes. Everything lands under the run dir (docs/benchmarks/
// <run-id>) so it can be committed.

export interface RunManifest {
  runId: string
  name?: string
  createdAt: string
  tasks: string[]
  /** Exact `provider:model` ids compared. */
  models: string[]
  /** Exact `id@vN` prompt versions compared. */
  prompts: string[]
  cellCount: number
}

function uniq(values: string[]): string[] {
  return [...new Set(values)].sort()
}

function gradingDoc(result: CandidateResult): string {
  const rubric = rubricFor(result.cell.task)
  const dims = rubric.dimensions
    .map((d) => `- \`${d.key}\` — **${d.label}** (weight ${d.weight}): ${d.description}`)
    .join('\n')
  const body = result.error
    ? `**The candidate run failed:** ${result.error}\n\nScore every dimension 1 (a failed run produces no usable work).`
    : `\`\`\`\n${result.output}\n\`\`\``
  return [
    `# Grading task: ${result.id}`,
    '',
    `- **Task:** ${result.cell.task}`,
    `- **Fixture:** ${result.cell.fixtureId}`,
    `- **Model (exact):** ${result.cell.model}`,
    `- **Prompt (exact):** ${result.cell.prompt}`,
    `- **Variant:** ${result.cell.variant}`,
    '',
    '## Rubric — score each dimension 1–5',
    dims,
    '',
    '## Task input (what the agent was given)',
    '```',
    result.input,
    '```',
    '',
    '## Candidate output (what to grade)',
    body,
    '',
  ].join('\n')
}

function indexDoc(runId: string, results: CandidateResult[]): string {
  const rows = results.map(
    (r) => `- [ ] \`${r.id}\` — ${r.cell.task} · ${r.cell.model} · ${r.cell.prompt}`,
  )
  return [
    `# Grading index — run \`${runId}\``,
    '',
    `${results.length} cells to grade. For each \`grading/<id>.md\`, score every rubric`,
    'dimension 1–5 with a one-line rationale and a weighted total, then write `grades.json`',
    'and the summary/conclusions documents per the **benchmark-arbiter** skill.',
    '',
    ...rows,
    '',
  ].join('\n')
}

export async function writeRunArtifacts(opts: {
  outDir: string
  runId: string
  config: BenchmarkConfig
  results: CandidateResult[]
  log?: (msg: string) => void
}): Promise<RunManifest> {
  const { outDir, runId, config, results } = opts
  const log = opts.log ?? (() => {})
  const gradingDir = join(outDir, 'grading')
  await mkdir(gradingDir, { recursive: true })

  const manifest: RunManifest = {
    runId,
    name: config.name,
    createdAt: new Date().toISOString(),
    tasks: uniq(results.map((r) => r.cell.task)),
    models: uniq(results.map((r) => r.cell.model)),
    prompts: uniq(results.map((r) => r.cell.prompt)),
    cellCount: results.length,
  }

  await writeFile(join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  await writeFile(join(outDir, 'candidates.json'), `${JSON.stringify(results, null, 2)}\n`, 'utf8')
  await writeFile(join(gradingDir, 'INDEX.md'), indexDoc(runId, results), 'utf8')
  for (const result of results) {
    await writeFile(join(gradingDir, `${result.id}.md`), gradingDoc(result), 'utf8')
  }
  log(`wrote ${results.length} candidate(s) + grading artifacts to ${outDir}`)
  return manifest
}
