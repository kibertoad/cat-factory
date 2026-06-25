import { join } from 'node:path'
import { mkdir } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { AgentInfraSpec, AgentJob, AgentResult } from './job.js'
import { cloneRepo, openPullRequest } from './git.js'
import type { PiRunStats } from './pi.js'
import { noChangesReason, runCodingAgent } from './coding-agent.js'
import {
  agentNeverActed,
  agentOutputTail,
  NEVER_ACTED_CAUSE,
  runAgentInWorkspace,
  unusableFinalAnswerCause,
  withWorkspace,
} from './pi-workspace.js'
import {
  type StructuredOutputDiagnostics,
  diagnosticsSuffix,
  resolveStructuredOutput,
} from './structured-output.js'
import type { RunOptions } from './runner.js'
import { log } from './logger.js'

// The single generic agent handler — the manifest-driven replacement for the bespoke
// per-kind handlers. It runs an LLM over an optional checkout and returns text/JSON
// (`explore`) or commits + pushes its edits and optionally opens a PR (`coding`). It
// holds NO per-agent-kind logic: WHAT the agent does is decided by the backend and
// passed as job data, and all mechanical work (rendering artifact files from the
// structured output, board ingest) happens on the backend before/after this run.

const exec = promisify(execFile)

/**
 * Bring the service's docker-compose dependencies up (local infra only). Best-effort:
 * runs `docker compose -f <path> up -d --wait` in the checkout. A missing Docker daemon
 * or a compose failure is logged and surfaced to the agent (as a prompt note) rather
 * than failing the job — the agent can still run unit-level tests and report what it
 * could. A no-op for ephemeral / no-infra / no-compose-path runs.
 */
async function standUpInfra(
  dir: string,
  infra: AgentInfraSpec,
  signal: AbortSignal | undefined,
  trace: Record<string, unknown>,
): Promise<{ started: boolean; note?: string }> {
  if (infra.environment !== 'local' || infra.noInfraDependencies || !infra.composePath) {
    return { started: false }
  }
  try {
    log.info('agent(explore): standing up infra', { ...trace, composePath: infra.composePath })
    await exec('docker', ['compose', '-f', infra.composePath, 'up', '-d', '--wait'], {
      cwd: dir,
      signal,
      timeout: 5 * 60_000,
    })
    return { started: true }
  } catch (err) {
    const note = err instanceof Error ? err.message : String(err)
    log.warn('agent(explore): infra stand-up failed', { ...trace, error: note })
    return { started: false, note }
  }
}

/** Tear the docker-compose dependencies down (best-effort; a no-op when none were started). */
async function tearDownInfra(dir: string, infra: AgentInfraSpec): Promise<void> {
  if (infra.environment !== 'local' || infra.noInfraDependencies || !infra.composePath) return
  try {
    await exec('docker', ['compose', '-f', infra.composePath, 'down', '-v'], {
      cwd: dir,
      timeout: 2 * 60_000,
    })
  } catch {
    // The container is ephemeral and torn down with the run anyway — ignore.
  }
}

/** Extract the first JSON object from an agent's final message (tolerating fences/prose). */
function extractJsonObject(text: string): unknown {
  const trimmed = text.trim()
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed)
  const body = fenced ? (fenced[1] ?? '') : trimmed
  try {
    return JSON.parse(body)
  } catch {
    const start = body.indexOf('{')
    const end = body.lastIndexOf('}')
    if (start === -1 || end === -1 || end <= start) {
      throw new Error('agent did not return a JSON object')
    }
    return JSON.parse(body.slice(start, end + 1))
  }
}

/** Run one generic agent job end to end, dispatching on `mode`. */
export async function handleAgent(job: AgentJob, opts: RunOptions = {}): Promise<AgentResult> {
  return job.mode === 'coding' ? runCodingMode(job, opts) : runExploreMode(job, opts)
}

/**
 * Read-only exploration: clone `branch`, run the agent making no edits, and return its
 * prose report — or, when `output.kind==='structured'`, the parsed JSON object as
 * `custom` (the backend renders any artifact files from it in a post-op). An edit-free
 * run is the expected, correct outcome; the only failure is producing no usable output.
 */
async function runExploreMode(job: AgentJob, opts: RunOptions): Promise<AgentResult> {
  const trace = {
    jobId: job.jobId,
    repo: `${job.repo.owner}/${job.repo.name}`,
    branch: job.branch,
  }
  return withWorkspace('agent-explore', async (dir) => {
    log.info('agent(explore): cloning', trace)
    await cloneRepo({
      repo: { ...job.repo, baseBranch: job.branch },
      ghToken: job.ghToken,
      dir,
      full: job.full,
      signal: opts.signal,
    })

    // Monorepo: run with cwd set to the service subtree (created if missing), mirroring
    // the coding flow so a service-scoped exploration sees the right subdirectory.
    const serviceDirectory = job.repo.serviceDirectory
    const workDir = serviceDirectory ? join(dir, serviceDirectory) : dir
    if (serviceDirectory) await mkdir(workDir, { recursive: true })

    // Optional infra stand-up (the tester): bring the service's docker-compose
    // dependencies up at the repo root for the duration of the run, tearing them down in
    // the `finally`. A stand-up failure is non-fatal — it's surfaced to the agent as a
    // prompt note so it can still run what it can and flag dependency gaps as concerns.
    // The run-mode guidance itself lives in the backend-composed system/user prompt; the
    // harness only manages the lifecycle + this dynamic stand-up note.
    const infra = job.infra
    const standUp = infra ? await standUpInfra(dir, infra, opts.signal, trace) : { started: false }
    const userPrompt = standUp.note
      ? `${job.userPrompt}\n\nNote: standing the infra up reported a problem (${standUp.note}). ` +
        `Test what you can and flag any dependency-related gaps as concerns.`
      : job.userPrompt

    try {
      log.info('agent(explore): running agent', { ...trace, serviceDirectory })
      const {
        summary,
        stats,
        stderrTail,
        usage,
        diagnostics: runDiag,
      } = await runAgentInWorkspace(
        {
          dir: workDir,
          systemPrompt: job.systemPrompt,
          userPrompt,
          model: job.model,
          harness: job.harness,
          subscriptionToken: job.subscriptionToken,
          subscriptionBaseUrl: job.subscriptionBaseUrl,
          proxyBaseUrl: job.proxyBaseUrl,
          sessionToken: job.sessionToken,
          serviceDirectory,
          // Read-only: it inspects and reports, making no edits — so the no-progress
          // guard's no-edit bound must not fire on its legitimately edit-free run.
          expectsEdits: false,
          webToolsGuidance: job.webToolsGuidance,
          webSearchProxy: job.webSearch,
        },
        opts,
      )

      if (!summary.trim()) {
        return {
          summary,
          stats,
          error: noOutputReason(stats, stderrTail),
          ...(usage ? { usage } : {}),
        }
      }

      // Opt-in (document producers): a final answer cut off at the output ceiling — or empty —
      // must FAIL LOUDLY here, BEFORE the structured repair below could launder a truncated
      // reply into a half-baked doc the backend then shards/commits + hands onward. Mirrors the
      // bespoke `/spec` handler's `unusableFinalAnswerCause` gate (which drove the old loop).
      if (job.output?.kind === 'structured' && job.output.failOnUnusableFinal) {
        const unusable = unusableFinalAnswerCause(runDiag)
        if (unusable) {
          return {
            summary,
            stats,
            error: `the agent did not return a usable result: ${unusable}.${agentOutputTail(stderrTail, summary)}`,
            ...(usage ? { usage } : {}),
          }
        }
      }

      // Prose: the summary IS the deliverable.
      if (job.output?.kind !== 'structured') {
        log.info('agent(explore): done (prose)', { ...trace, ...stats })
        return { summary, stats, ...(usage ? { usage } : {}) }
      }

      // Structured: parse the agent's JSON. With repair enabled (default) a malformed
      // reply gets ONE structured repair call before giving up; with `repair:false` we
      // parse directly (no repair channel). The backend coerces/validates + renders from
      // the returned object in a post-op.
      let custom: unknown = null
      let diagnostics: StructuredOutputDiagnostics | undefined
      if (job.output.repair === false) {
        try {
          custom = extractJsonObject(summary)
        } catch {
          custom = null
        }
      } else {
        const resolved = await resolveStructuredOutput(
          {
            label: 'agent',
            shapeHint: job.output.shapeHint ?? 'Expected a single JSON object.',
            parse: (text) => extractJsonObject(text),
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
        custom = resolved.value
        diagnostics = resolved.diagnostics
      }
      if (custom === undefined || custom === null) {
        return {
          summary,
          stats,
          error: noStructuredReason(stats, stderrTail, diagnostics),
          ...(usage ? { usage } : {}),
        }
      }
      // Stamp the run's actual environment authoritatively onto the structured result when
      // infra was managed (the tester): which env the suite ran in is decided by the job's
      // infra spec, NOT the model, so the backend can echo it back to the UI deterministically
      // even when the model omits it from its JSON (or a structured repair drops it).
      if (infra && typeof custom === 'object') {
        ;(custom as Record<string, unknown>).environment = infra.environment
      }
      log.info('agent(explore): done (structured)', { ...trace, ...stats })
      return { summary, custom, stats, ...(usage ? { usage } : {}) }
    } finally {
      if (infra) await tearDownInfra(dir, infra)
    }
  })
}

/**
 * Edit-and-push coding: clone `branch` (or resume `newBranch`), run the agent, commit +
 * push to `pushBranch`, and open `pr` when one is set and the run produced changes. A
 * no-op is a failure for the implementer (`noChangesIsError` default) and a non-fatal
 * no-op for the in-place fixers.
 */
async function runCodingMode(job: AgentJob, opts: RunOptions): Promise<AgentResult> {
  const pushBranch = job.pushBranch ?? job.newBranch ?? job.branch
  const { summary, stats, stderrTail, pushed, usage } = await runCodingAgent(
    {
      kind: 'agent',
      jobId: job.jobId,
      repo: job.repo,
      cloneBranch: job.branch,
      ...(job.newBranch ? { newBranch: job.newBranch } : {}),
      pushBranch,
      ghToken: job.ghToken,
      systemPrompt: job.systemPrompt,
      userPrompt: job.userPrompt,
      model: job.model,
      harness: job.harness,
      subscriptionToken: job.subscriptionToken,
      subscriptionBaseUrl: job.subscriptionBaseUrl,
      proxyBaseUrl: job.proxyBaseUrl,
      sessionToken: job.sessionToken,
      commitMessage: job.commitMessage ?? job.pr?.title ?? 'Agent changes',
      webToolsGuidance: job.webToolsGuidance,
      webSearchProxy: job.webSearch,
    },
    opts,
  )

  if (!pushed) {
    // A no-op: a failure for the implementer, a clean non-event for the fixers.
    if (job.noChangesIsError === false) {
      return { pushed: false, branch: pushBranch, summary, stats, ...(usage ? { usage } : {}) }
    }
    return {
      pushed: false,
      branch: pushBranch,
      summary,
      stats,
      error: noChangesReason('the agent produced no file changes', stats, stderrTail),
      ...(usage ? { usage } : {}),
    }
  }

  // Changes are on the branch. Open a PR only when the job asked for one.
  if (job.pr) {
    const prUrl = await openPullRequest({
      owner: job.repo.owner,
      name: job.repo.name,
      ghToken: job.ghToken,
      head: pushBranch,
      base: job.repo.baseBranch,
      pr: job.pr,
      apiBase: job.githubApiBase,
      signal: opts.signal,
    })
    return { pushed: true, prUrl, branch: pushBranch, summary, stats, ...(usage ? { usage } : {}) }
  }
  return { pushed: true, branch: pushBranch, summary, stats, ...(usage ? { usage } : {}) }
}

/** Human-readable reason a read-only run produced no usable output. */
function noOutputReason(stats: PiRunStats, stderrTail: string | undefined): string {
  const cause = agentNeverActed(stats)
    ? ' (the agent never acted — it most likely could not reach the model)'
    : ''
  return `the agent produced no report${cause}.${agentOutputTail(stderrTail)}`
}

/** Human-readable reason a structured run produced no parseable JSON. */
function noStructuredReason(
  stats: PiRunStats,
  stderrTail: string | undefined,
  diagnostics?: StructuredOutputDiagnostics,
): string {
  const cause = agentNeverActed(stats)
    ? NEVER_ACTED_CAUSE
    : ' The agent did not return a parseable JSON object.'
  return `the agent produced no structured result.${cause}${diagnostics ? diagnosticsSuffix(diagnostics) : ''}${agentOutputTail(stderrTail)}`
}
