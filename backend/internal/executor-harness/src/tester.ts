import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { TesterJob, TesterResult, TesterTestSpec } from './job.js'
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

const exec = promisify(execFile)

// Async job execution for the Tester. The engine dispatches this to run the project's
// tests: clone the PR HEAD branch, stand its dependencies up (local docker-compose
// infra, or test against an ephemeral env), run Pi to exercise the change + regress
// related behaviour, and return ONLY a structured JSON report. The Tester makes NO
// commits — on a withheld greenlight the engine loops the `fixer` and re-tests.

/** Compact description of the report shape, fed to the JSON repair call. */
const REPORT_SHAPE_HINT =
  'Expected a test report: {"greenlight": boolean, "summary": string, "tested": string[], ' +
  '"outcomes": [{"name": string, "status": "passed"|"failed"|"skipped", "detail"?: string}], ' +
  '"concerns": [{"title": string, "detail": string, "severity": "low"|"medium"|"high"|"critical"}]}.'

interface TestReportShape {
  greenlight: boolean
  summary: string
  tested: string[]
  outcomes: { name: string; status: 'passed' | 'failed' | 'skipped'; detail?: string }[]
  concerns: { title: string; detail: string; severity: 'low' | 'medium' | 'high' | 'critical' }[]
  environment?: 'local' | 'ephemeral'
}

const SEVERITIES = new Set(['low', 'medium', 'high', 'critical'])
const STATUSES = new Set(['passed', 'failed', 'skipped'])

/** Coerce the agent's JSON into a well-formed report, defaulting conservatively. */
function coerceReport(
  raw: unknown,
  summary: string,
  env: TesterTestSpec['environment'],
): TestReportShape {
  const o = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
  const outcomes = Array.isArray(o.outcomes)
    ? (o.outcomes as unknown[])
        .filter((x): x is Record<string, unknown> => typeof x === 'object' && x !== null)
        .map((x) => ({
          name: typeof x.name === 'string' ? x.name : '(unnamed)',
          status: (STATUSES.has(x.status as string)
            ? x.status
            : 'skipped') as TestReportShape['outcomes'][number]['status'],
          ...(typeof x.detail === 'string' && x.detail ? { detail: x.detail } : {}),
        }))
    : []
  const concerns = Array.isArray(o.concerns)
    ? (o.concerns as unknown[])
        .filter((x): x is Record<string, unknown> => typeof x === 'object' && x !== null)
        .map((x) => ({
          title: typeof x.title === 'string' ? x.title : '(concern)',
          detail: typeof x.detail === 'string' ? x.detail : '',
          severity: (SEVERITIES.has(x.severity as string)
            ? x.severity
            : 'medium') as TestReportShape['concerns'][number]['severity'],
        }))
    : []
  // A greenlight is only honoured when no concerns were raised — never auto-pass a
  // run that listed problems, even if the model set greenlight:true by mistake.
  const greenlight = o.greenlight === true && concerns.length === 0
  return {
    greenlight,
    summary: typeof o.summary === 'string' && o.summary ? o.summary : summary.slice(0, 2000),
    tested: Array.isArray(o.tested)
      ? (o.tested as unknown[]).filter((t): t is string => typeof t === 'string')
      : [],
    outcomes,
    concerns,
    environment: env,
  }
}

/** Build the tester task prompt: how to bring the deps up + what to test. */
function buildUserPrompt(job: TesterJob): string {
  const lines = [job.userPrompt, '']
  if (job.test.environment === 'ephemeral') {
    lines.push(
      'Run mode: ephemeral environment.',
      job.test.environmentUrl
        ? `Test against the deployed environment at ${job.test.environmentUrl}. Do not start the service locally.`
        : 'Test against the provided ephemeral environment URL from your context. Do not start the service locally.',
    )
  } else if (job.test.noInfraDependencies) {
    lines.push(
      'Run mode: local, no infra dependencies — just install, build and run the test suite directly.',
    )
  } else {
    lines.push(
      "Run mode: local. The service's infra dependencies from its docker-compose file have been started and are reachable on localhost. Read the README to learn how to configure the service against them, run any migrations, start the service and exercise it.",
    )
  }
  lines.push('', 'Respond with ONLY the JSON test report described in your instructions.')
  return lines.join('\n')
}

/**
 * Bring the service's docker-compose dependencies up (local mode only). Best-effort:
 * runs `docker compose -f <path> up -d --wait` in the checkout. A missing Docker
 * daemon or a compose failure is logged and surfaced to the agent rather than failing
 * the whole job — the agent can still run unit-level tests and report what it could.
 */
async function standUpInfra(
  dir: string,
  test: TesterTestSpec,
  signal: AbortSignal | undefined,
  trace: Record<string, unknown>,
): Promise<{ started: boolean; note?: string }> {
  if (test.environment !== 'local' || test.noInfraDependencies || !test.composePath) {
    return { started: false }
  }
  try {
    log.info('test: standing up infra', { ...trace, composePath: test.composePath })
    await exec('docker', ['compose', '-f', test.composePath, 'up', '-d', '--wait'], {
      cwd: dir,
      signal,
      timeout: 5 * 60_000,
    })
    return { started: true }
  } catch (err) {
    const note = err instanceof Error ? err.message : String(err)
    log.warn('test: infra stand-up failed', { ...trace, error: note })
    return { started: false, note }
  }
}

/** Tear the docker-compose dependencies down (best-effort). */
async function tearDownInfra(dir: string, test: TesterTestSpec): Promise<void> {
  if (test.environment !== 'local' || test.noInfraDependencies || !test.composePath) return
  try {
    await exec('docker', ['compose', '-f', test.composePath, 'down', '-v'], {
      cwd: dir,
      timeout: 2 * 60_000,
    })
  } catch {
    // The container is ephemeral and torn down with the run anyway — ignore.
  }
}

/** Run one Tester job end to end: clone branch → stand up infra → Pi tests → report. */
export async function handleTester(job: TesterJob, opts: RunOptions = {}): Promise<TesterResult> {
  const trace = { jobId: job.jobId, repo: `${job.repo.owner}/${job.repo.name}`, branch: job.branch }
  return withWorkspace('test', async (dir) => {
    log.info('test: cloning PR branch', trace)
    await cloneRepo({
      repo: { ...job.repo, baseBranch: job.branch },
      ghToken: job.ghToken,
      dir,
      signal: opts.signal,
    })

    const infra = await standUpInfra(dir, job.test, opts.signal, trace)
    try {
      log.info('test: running agent', { ...trace, environment: job.test.environment })
      let userPrompt = buildUserPrompt(job)
      if (infra.note) {
        userPrompt += `\n\nNote: standing the infra up reported a problem (${infra.note}). Test what you can and flag any dependency-related gaps as concerns.`
      }
      const { summary, stats, stderrTail, usage } = await runAgentInWorkspace(
        {
          dir,
          systemPrompt: job.systemPrompt,
          userPrompt,
          model: job.model,
          harness: job.harness,
          subscriptionToken: job.subscriptionToken,
          subscriptionBaseUrl: job.subscriptionBaseUrl,
          proxyBaseUrl: job.proxyBaseUrl,
          sessionToken: job.sessionToken,
          // The tester only assesses (it commits nothing), so the no-edit guard must
          // not fire on its legitimately edit-free run.
          expectsEdits: false,
        },
        opts,
      )

      const { value: report, diagnostics } = await resolveStructuredOutput(
        {
          label: 'tester',
          shapeHint: REPORT_SHAPE_HINT,
          parse: (text) => coerceReport(extractJsonObject(text), text, job.test.environment),
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
      if (!report) {
        return {
          summary,
          stats,
          error: noReportReason(stats, stderrTail, diagnostics),
          ...(usage ? { usage } : {}),
        }
      }
      log.info('test: reported', {
        ...trace,
        greenlight: report.greenlight,
        concerns: report.concerns.length,
      })
      return { report, summary, stats, ...(usage ? { usage } : {}) }
    } finally {
      await tearDownInfra(dir, job.test)
    }
  })
}

/** Human-readable reason a tester run produced no usable report. */
function noReportReason(
  stats: PiRunStats,
  stderrTail: string | undefined,
  diagnostics?: StructuredOutputDiagnostics,
): string {
  const cause = agentNeverActed(stats)
    ? NEVER_ACTED_CAUSE
    : ' The agent did not return a parseable JSON test report.'
  return `Tester produced no report.${cause}${diagnostics ? diagnosticsSuffix(diagnostics) : ''}${agentOutputTail(stderrTail)}`
}
