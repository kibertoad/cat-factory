import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { RunCaseOutput } from './case'
import type { SmoketestConfig } from './config'
import { renderTranscript } from './transcript'
import type { CaseMetrics, Finding, SmoketestCaseResult, Verdict } from './types'

// Writes a smoketest run to disk: one folder per case (the captured prompts, the
// raw + rendered transcript, the diff, the analysis) plus run-level results +
// a human-readable report. Everything lands under the run dir (docs/smoketests/
// <run-id>) so a run can be committed as a record. No grading artifacts.

export interface RunManifest {
  runId: string
  name?: string
  createdAt: string
  models: string[]
  fixtures: string[]
  caseCount: number
  verdicts: Record<Verdict, number>
}

function uniq(values: string[]): string[] {
  return [...new Set(values)].sort()
}

const VERDICT_MARK: Record<Verdict, string> = {
  healthy: '✅',
  degraded: '⚠️',
  broken: '❌',
}

const SEVERITY_MARK: Record<Finding['severity'], string> = {
  error: '🔴',
  warn: '🟡',
  info: 'ℹ️',
}

function metricsBlock(m: CaseMetrics): string {
  const lines = [
    `- verdict-driving metrics:`,
    `  - tool calls: ${m.toolCalls} (${m.toolErrors} errored, ${m.edits} edit-tool)`,
    `  - assistant text: ${m.assistantChars} chars · events: ${m.events}`,
    `  - diff: ${m.diffBytes} bytes across ${m.filesChanged} file(s)`,
    `  - duration: ${(m.durationMs / 1000).toFixed(1)}s`,
  ]
  if (m.todo) lines.push(`  - todo: ${m.todo.completed}/${m.todo.total} done`)
  if (m.usage) lines.push(`  - tokens: ${m.usage.inputTokens} in / ${m.usage.outputTokens} out`)
  const hist = Object.entries(m.toolHistogram)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k}×${v}`)
    .join(', ')
  if (hist) lines.push(`  - tools: ${hist}`)
  return lines.join('\n')
}

function findingsBlock(findings: Finding[]): string {
  if (!findings.length) return '_No findings — the run looked healthy._'
  return findings
    .map((f) => {
      const detail = f.detail ? `\n  - ${f.detail.replace(/\n/g, ' ').slice(0, 300)}` : ''
      return `- ${SEVERITY_MARK[f.severity]} **${f.code}** (${f.category}) — ${f.message}${detail}`
    })
    .join('\n')
}

function analysisDoc(result: SmoketestCaseResult): string {
  return [
    `# ${result.id}`,
    '',
    `- **Verdict:** ${VERDICT_MARK[result.verdict]} ${result.verdict}`,
    `- **Fixture:** ${result.fixtureId} — ${result.fixtureTitle}`,
    `- **Model:** ${result.model}`,
    '',
    '## Findings',
    findingsBlock(result.findings),
    '',
    '## Metrics',
    metricsBlock(result.metrics),
    '',
    '## Agent summary',
    result.summary ? `> ${result.summary.replace(/\n/g, '\n> ')}` : '_(none)_',
    result.error ? `\n## Run error\n\n\`\`\`\n${result.error}\n\`\`\`` : '',
    '',
    'See `transcript.md` (rendered) and `transcript.jsonl` (raw, full prompts + responses) in this folder.',
    '',
  ].join('\n')
}

function promptDoc(prompts: { system: string; user: string }): string {
  return [
    '# Prompts given to the agent',
    '',
    '## System prompt (written to Pi global `~/.pi/agent/AGENTS.md`)',
    '',
    '```',
    prompts.system,
    '```',
    '',
    '## User prompt (the task, over stdin)',
    '',
    '```',
    prompts.user,
    '```',
    '',
  ].join('\n')
}

function reportDoc(runId: string, results: SmoketestCaseResult[]): string {
  const header = [
    `# Smoketest report — \`${runId}\``,
    '',
    'Structural health of the Pi coding agent per model × task. **Not a quality score** —',
    'each verdict flags whether the agent could do the work at all, got dead-ended, or',
    'looped unproductively. Drill into a case folder for its transcript + findings.',
    '',
    '| Case | Model | Verdict | Findings | Tool calls | Diff (B) |',
    '| --- | --- | --- | --- | --- | --- |',
  ]
  const rows = results.map((r) => {
    const codes = r.findings.map((f) => f.code).join(', ') || '—'
    return `| ${r.fixtureId} | ${r.model} | ${VERDICT_MARK[r.verdict]} ${r.verdict} | ${codes} | ${r.metrics.toolCalls} | ${r.metrics.diffBytes} |`
  })

  const broken = results.filter((r) => r.verdict === 'broken')
  const degraded = results.filter((r) => r.verdict === 'degraded')
  const callouts: string[] = ['', '## What to look at first', '']
  if (!broken.length && !degraded.length) {
    callouts.push('All cases healthy. 🎉')
  } else {
    for (const r of [...broken, ...degraded]) {
      callouts.push(`### ${VERDICT_MARK[r.verdict]} ${r.id}`, '', findingsBlock(r.findings), '')
    }
  }

  return [...header, ...rows, ...callouts, ''].join('\n')
}

/** Strip the raw events/diff off a captured output, leaving the committable result. */
export function toResult(output: RunCaseOutput): SmoketestCaseResult {
  return output.result
}

export async function writeRunArtifacts(opts: {
  outDir: string
  runId: string
  config: SmoketestConfig
  outputs: RunCaseOutput[]
  log?: (msg: string) => void
}): Promise<RunManifest> {
  const { outDir, runId, outputs } = opts
  const log = opts.log ?? (() => {})
  const results = outputs.map(toResult)

  const verdicts: Record<Verdict, number> = { healthy: 0, degraded: 0, broken: 0 }
  for (const r of results) verdicts[r.verdict]++

  const manifest: RunManifest = {
    runId,
    name: opts.config.name,
    createdAt: new Date().toISOString(),
    models: uniq(results.map((r) => r.model)),
    fixtures: uniq(results.map((r) => r.fixtureId)),
    caseCount: results.length,
    verdicts,
  }

  const casesDir = join(outDir, 'cases')
  await mkdir(casesDir, { recursive: true })
  for (const output of outputs) {
    const dir = join(casesDir, output.result.id)
    await mkdir(dir, { recursive: true })
    const jsonl = output.events.map((e) => JSON.stringify(e)).join('\n')
    await Promise.all([
      writeFile(join(dir, 'analysis.md'), analysisDoc(output.result), 'utf8'),
      writeFile(join(dir, 'prompt.md'), promptDoc(output.prompts), 'utf8'),
      writeFile(join(dir, 'transcript.jsonl'), jsonl ? `${jsonl}\n` : '', 'utf8'),
      writeFile(join(dir, 'transcript.md'), renderTranscript(output.events), 'utf8'),
      writeFile(join(dir, 'diff.patch'), output.diff, 'utf8'),
    ])
  }

  await writeFile(join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  await writeFile(join(outDir, 'results.json'), `${JSON.stringify(results, null, 2)}\n`, 'utf8')
  await writeFile(join(outDir, 'report.md'), reportDoc(runId, results), 'utf8')

  log(`wrote ${results.length} case(s) to ${outDir}`)
  return manifest
}
