import type { MergerJob, MergerResult } from './job.js'
import { cloneRepo, hasDiffAgainstBase } from './git.js'
import { extractJsonObject } from './blueprint.js'
import type { PiRunStats } from './pi.js'
import {
  agentNeverActed,
  agentOutputTail,
  NEVER_ACTED_CAUSE,
  runAgentInWorkspace,
  withWorkspace,
} from './pi-workspace.js'
import {
  type StructuredOutputDiagnostics,
  diagnosticsSuffix,
  resolveStructuredOutput,
} from './structured-output.js'
import type { RunOptions } from './runner.js'
import { log } from './logger.js'

/** Compact description of the merge-assessment shape, fed to the JSON repair call. */
const ASSESSMENT_SHAPE_HINT =
  'Expected a merge assessment: {"complexity": number 0..1, "risk": number 0..1, ' +
  '"impact": number 0..1, "rationale": string}.'

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
    rationale:
      typeof o.rationale === 'string' && o.rationale ? o.rationale : summary.slice(0, 2000),
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
  const trace = { jobId: job.jobId, repo: `${job.repo.owner}/${job.repo.name}`, branch: job.branch }
  return withWorkspace('merge', async (dir) => {
    log.info('merge: cloning PR branch', trace)
    await cloneRepo({
      repo: { ...job.repo, baseBranch: job.branch },
      ghToken: job.ghToken,
      dir,
      // Full clone: scoring the PR means diffing it against the base, which needs the
      // base branch's remote-tracking ref (origin/<base>) AND the merge base present. A
      // shallow single-branch clone has neither, so `git diff origin/<base>...HEAD` fails
      // with "branch not found" and the agent is left to GUESS scores (it tends to emit
      // 0/0/0, which then auto-merges). The full clone gives the merger a real diff.
      full: true,
      signal: opts.signal,
    })

    // Guard the auto-merge path: confirm a real diff against the base is examinable. If
    // it is not (missing base ref / empty diff), the agent's scores can't be trusted —
    // we force a CONSERVATIVE assessment below so the engine routes to human review
    // rather than auto-merging on bogus low scores.
    const diffExaminable = await hasDiffAgainstBase(dir, job.repo.baseBranch, opts.signal)
    if (!diffExaminable) {
      log.warn('merge: no examinable diff against base; will assess conservatively', trace)
    }

    log.info('merge: running agent', trace)
    const { summary, stats, stderrTail, usage } = await runAgentInWorkspace(
      {
        dir,
        systemPrompt: job.systemPrompt,
        userPrompt: buildUserPrompt(job),
        model: job.model,
        harness: job.harness,
        subscriptionToken: job.subscriptionToken,
        subscriptionBaseUrl: job.subscriptionBaseUrl,
        proxyBaseUrl: job.proxyBaseUrl,
        sessionToken: job.sessionToken,
        // The merger only assesses (no commits/edits), so the no-edit guard must
        // not fire on its legitimately edit-free run.
        expectsEdits: false,
      },
      opts,
    )

    // Parse the agent's assessment; on a malformed reply, make ONE structured repair
    // call (see structured-output) before giving up. `coerceAssessment` only yields
    // null when no JSON object could be extracted at all (it defaults conservatively
    // otherwise), so a usable-but-vague reply still routes to human review as before.
    const { value: assessment, diagnostics } = await resolveStructuredOutput(
      {
        label: 'merger',
        shapeHint: ASSESSMENT_SHAPE_HINT,
        parse: (text) => coerceAssessment(extractJsonObject(text), text),
      },
      summary,
      {
        harness: job.harness,
        subscriptionToken: job.subscriptionToken,
        subscriptionBaseUrl: job.subscriptionBaseUrl,
        proxyBaseUrl: job.proxyBaseUrl,
        sessionToken: job.sessionToken,
        model: job.model,
        jobId: job.jobId,
        signal: opts.signal,
      },
    )
    if (!assessment) {
      return {
        summary,
        stats,
        error: noAssessmentReason(stats, stderrTail, diagnostics),
        ...(usage ? { usage } : {}),
      }
    }
    // The agent could not actually examine the change: its scores are not trustworthy
    // (a failed diff retrieval typically yields a bogus 0/0/0 that would auto-merge).
    // Return a CONSERVATIVE assessment (max on every axis) so the engine's threshold
    // check fails and the PR is routed to a human merge review instead.
    if (!diffExaminable) {
      const conservative = {
        complexity: 1,
        risk: 1,
        impact: 1,
        rationale:
          `Could not examine a real diff of \`${job.branch}\` against \`${job.repo.baseBranch}\` ` +
          `(the base ref was missing or the diff was empty), so this PR was NOT auto-assessed ` +
          `and needs a human merge review.`,
      }
      log.info('merge: assessed conservatively (no examinable diff)', { ...trace, ...conservative })
      return { assessment: conservative, summary, stats, ...(usage ? { usage } : {}) }
    }
    log.info('merge: assessed', { ...trace, ...assessment })
    return { assessment, summary, stats, ...(usage ? { usage } : {}) }
  })
}

/** Human-readable reason a merger run produced no usable assessment. */
function noAssessmentReason(
  stats: PiRunStats,
  stderrTail: string | undefined,
  diagnostics?: StructuredOutputDiagnostics,
): string {
  const cause = agentNeverActed(stats)
    ? NEVER_ACTED_CAUSE
    : ' The agent did not return a parseable JSON assessment.'
  return `Merger produced no assessment.${cause}${diagnostics ? diagnosticsSuffix(diagnostics) : ''}${agentOutputTail(stderrTail)}`
}
