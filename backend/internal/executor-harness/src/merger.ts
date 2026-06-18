import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { MergerJob, MergerResult } from './job.js'
import { cloneRepo } from './git.js'
import { extractJsonObject } from './blueprint.js'
import { runPi, type PiRunStats, writeAgentsContext, writePiModelsConfig } from './pi.js'
import type { RunOptions } from './runner.js'
import { log } from './logger.js'

// Async job execution for the merger. The engine dispatches this as the last
// pipeline step: clone the PR HEAD branch, have Pi assess the change vs the base
// branch along three axes (complexity / risk / impact, each 0..1) and return ONLY
// a JSON assessment. The merger makes NO commits — the Worker performs the real
// merge through the GitHub API when the engine's threshold check passes; otherwise
// the engine raises a `merge_review` notification carrying this assessment.

interface MergeAssessmentShape {
  complexity: number
  risk: number
  impact: number
  rationale: string
}

/** Clamp a value to a 0..1 number, defaulting to `fallback` when not finite. */
function clamp01(value: unknown, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(1, Math.max(0, n))
}

/**
 * Coerce the agent's JSON into a well-formed assessment. Missing/garbage scores
 * default to a CONSERVATIVE 1 (treat as severe → routes to human review rather
 * than a silent auto-merge); the rationale falls back to the raw summary.
 */
function coerceAssessment(raw: unknown, summary: string): MergeAssessmentShape {
  const o = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
  return {
    complexity: clamp01(o.complexity, 1),
    risk: clamp01(o.risk, 1),
    impact: clamp01(o.impact, 1),
    rationale: typeof o.rationale === 'string' && o.rationale ? o.rationale : summary.slice(0, 2000),
  }
}

/** Build the merger task prompt: assess the PR branch against the base. */
function buildUserPrompt(job: MergerJob): string {
  const pr = job.prNumber !== undefined ? ` (PR #${job.prNumber})` : ''
  return [
    job.instructions,
    '',
    `The pull request${pr} is on branch \`${job.branch}\`; the base branch is ` +
      `\`${job.repo.baseBranch}\`. Inspect the change (e.g. \`git fetch origin ${job.repo.baseBranch}\` ` +
      `then \`git diff origin/${job.repo.baseBranch}...HEAD\`) and score complexity, risk and impact.`,
    '',
    'Respond with ONLY a JSON object {"complexity":0.0,"risk":0.0,"impact":0.0,"rationale":"…"}.',
  ].join('\n')
}

/** Run one merger job end to end: clone branch → Pi assesses → return scores (no commit). */
export async function handleMerger(job: MergerJob, opts: RunOptions = {}): Promise<MergerResult> {
  const { signal, onActivity, onProgress } = opts
  const dir = await mkdtemp(join(tmpdir(), 'merge-'))
  const trace = { jobId: job.jobId, repo: `${job.repo.owner}/${job.repo.name}`, branch: job.branch }
  try {
    log.info('merge: cloning PR branch', trace)
    await cloneRepo({
      repo: { ...job.repo, baseBranch: job.branch },
      ghToken: job.ghToken,
      dir,
      signal,
    })
    await writeAgentsContext(dir, job.systemPrompt)
    await writePiModelsConfig({ model: job.model, proxyBaseUrl: job.proxyBaseUrl })

    log.info('merge: running agent', trace)
    const { summary, stats, stderrTail } = await runPi({
      cwd: dir,
      model: job.model,
      userPrompt: buildUserPrompt(job),
      sessionToken: job.sessionToken,
      signal,
      onActivity,
      onProgress,
    })

    let parsed: unknown
    try {
      parsed = extractJsonObject(summary)
    } catch (error) {
      log.error('merge: could not parse agent output', {
        ...trace,
        error: error instanceof Error ? error.message : String(error),
      })
      return { summary, stats, error: noAssessmentReason(stats, stderrTail) }
    }
    const assessment = coerceAssessment(parsed, summary)
    log.info('merge: assessed', { ...trace, ...assessment })
    return { assessment, summary, stats }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/** Human-readable reason a merger run produced no usable assessment. */
function noAssessmentReason(stats: PiRunStats, stderrTail: string | undefined): string {
  const acted = stats.toolCalls === 0 && stats.assistantChars === 0
  const cause = acted
    ? ' The agent never acted (no tool calls, no model output) — it most likely could not reach the model.'
    : ' The agent did not return a parseable JSON assessment.'
  const detail = stderrTail ? ` Agent stderr: ${stderrTail.slice(-700)}` : ''
  return `Merger produced no assessment.${cause}${detail}`
}
