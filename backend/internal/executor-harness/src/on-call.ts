import type { OnCallJob, OnCallResult } from './job.js'
import { cloneRepo } from './git.js'
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

// Async job execution for the on-call agent. The engine dispatches this when the
// post-release-health gate detects a Datadog regression. The released PR has already
// merged and its work branch was deleted, so we clone the BASE branch (which contains
// the merged change), have Pi locate the merged commit (via the PR number / the
// now-historical head branch) and correlate its diff with the regression evidence
// (handed in via the user prompt), then return ONLY a JSON assessment of whether THIS
// change is the likely culprit. The on-call agent makes NO commits and reverts nothing —
// the engine raises a `release_regression` notification carrying this assessment.

const ASSESSMENT_SHAPE_HINT =
  'Expected an on-call assessment: {"culpritConfidence": number 0..1, "recommendation": ' +
  '"revert"|"hold"|"monitor", "rationale": string, "evidence": string[]}.'

interface OnCallAssessmentShape {
  culpritConfidence: number
  recommendation: 'revert' | 'hold' | 'monitor'
  rationale: string
  evidence: string[]
}

function clamp01(value: unknown, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(1, Math.max(0, n))
}

function coerceRecommendation(value: unknown): 'revert' | 'hold' | 'monitor' {
  return value === 'revert' || value === 'monitor' ? value : 'hold'
}

/**
 * Coerce the agent's JSON into a well-formed assessment. A missing confidence defaults
 * to a CONSERVATIVE 0 (don't imply the PR is at fault without evidence); a missing
 * recommendation defaults to `hold` (human decides). Returns null only when no JSON
 * object could be extracted at all.
 */
function coerceAssessment(raw: unknown, summary: string): OnCallAssessmentShape | null {
  if (typeof raw !== 'object' || raw === null) return null
  const o = raw as Record<string, unknown>
  const evidence = Array.isArray(o.evidence)
    ? o.evidence.filter((e): e is string => typeof e === 'string')
    : []
  return {
    culpritConfidence: clamp01(o.culpritConfidence, 0),
    recommendation: coerceRecommendation(o.recommendation),
    rationale:
      typeof o.rationale === 'string' && o.rationale ? o.rationale : summary.slice(0, 2000),
    evidence,
  }
}

function buildUserPrompt(job: OnCallJob): string {
  const pr = job.prNumber !== undefined ? `#${job.prNumber}` : ''
  // The PR has already merged into the base branch and its work branch was deleted, so the
  // checkout is the base branch. Point the agent at how to find the merged commit.
  const locate = job.prNumber
    ? `It merged as a commit referencing ${pr} — find it with ` +
      `\`git log --oneline -n 50\` (squash/merge commits include \`(${pr})\`; a merge commit ` +
      `mentions \`#${job.prNumber}\`), then inspect it with \`git show <sha>\`.`
    : job.headBranch
      ? `Its work branch was \`${job.headBranch}\` (now deleted) — find the merged commit in ` +
        `\`git log --oneline -n 50\` and inspect it with \`git show <sha>\`.`
      : `Find the most recent merge/feature commit with \`git log --oneline -n 50\` and inspect ` +
        `it with \`git show <sha>\`.`
  return [
    job.userPrompt,
    '',
    `You are on the base branch \`${job.repo.baseBranch}\`, which already contains the released ` +
      `pull request ${pr}. ${locate} Correlate that change with the regression evidence above. ` +
      `Beware correlation vs causation.`,
    '',
    'Respond with ONLY a JSON object {"culpritConfidence":0.0,"recommendation":"revert"|"hold"|"monitor","rationale":"…","evidence":["…"]}.',
  ].join('\n')
}

/** Run one on-call job: clone branch → Pi investigates → return the assessment (no commit). */
export async function handleOnCall(job: OnCallJob, opts: RunOptions = {}): Promise<OnCallResult> {
  const trace = { jobId: job.jobId, repo: `${job.repo.owner}/${job.repo.name}`, branch: job.branch }
  return withWorkspace('on-call', async (dir) => {
    log.info('on-call: cloning base branch', trace)
    await cloneRepo({
      repo: { ...job.repo, baseBranch: job.branch },
      ghToken: job.ghToken,
      dir,
      // Full clone so the agent has the history to locate + diff the merged commit.
      full: true,
      signal: opts.signal,
    })

    log.info('on-call: running agent', trace)
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
        // Investigation only — no commits/edits, so the no-edit guard must not fire.
        expectsEdits: false,
      },
      opts,
    )

    const { value: assessment, diagnostics } = await resolveStructuredOutput(
      {
        label: 'on-call',
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
    log.info('on-call: assessed', { ...trace, ...assessment })
    return { onCallAssessment: assessment, summary, stats, ...(usage ? { usage } : {}) }
  })
}

function noAssessmentReason(
  stats: PiRunStats,
  stderrTail: string | undefined,
  diagnostics?: StructuredOutputDiagnostics,
): string {
  const cause = agentNeverActed(stats)
    ? NEVER_ACTED_CAUSE
    : ' The agent did not return a parseable JSON assessment.'
  return `On-call produced no assessment.${cause}${diagnostics ? diagnosticsSuffix(diagnostics) : ''}${agentOutputTail(stderrTail)}`
}
