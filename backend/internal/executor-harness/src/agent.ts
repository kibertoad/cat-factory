import { join } from 'node:path'
import { mkdir, opendir } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type {
  AgentInfraSpec,
  AgentJob,
  AgentResult,
  InfraSetupRecord,
  ServiceInfraSpec,
} from './job.js'
import { standUpFrontend, tearDownFrontend } from './frontend-infra.js'
import { captureRedactedOutput, redactSecrets } from './redact.js'
import {
  cloneRepo,
  commitAll,
  conflictDiff,
  hasAgentChanges,
  headCommit,
  mergeBranch,
  openPullRequest,
  prepareExistingCheckout,
  pushBranch,
  reinitAndPush,
  unmergedPaths,
} from './git.js'
import type { PiRunStats } from './pi.js'
import { noChangesReason, runCodingAgent } from './coding-agent.js'
import {
  acquireRepoCheckout,
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
import { log, type Logger } from './logger.js'

// The single generic agent handler — the manifest-driven replacement for the bespoke
// per-kind handlers. It runs an LLM over an optional checkout and returns text/JSON
// (`explore`) or commits + pushes its edits and optionally opens a PR (`coding`). WHAT
// the agent does is decided by the backend and passed as job DATA (never an agent-kind
// string), and all mechanical work that CAN run without a checkout (rendering artifact
// files from the structured output, board ingest) lives on the backend before/after this
// run via the RepoFiles port.
//
// Two coding flows still carry working-tree Git mechanics that a contents-API-only
// RepoFiles cannot perform, so they are keyed off job data here (NOT off a kind string):
// `mergeBase` ⇒ surface real merge conflicts via a working-tree base→branch merge
// (conflict resolution); `bootstrap` ⇒ reinitialise history and force-push to a separate
// target repo. These are the deliberate, documented exceptions — do NOT grow this into a
// general `if (job.someFlag)` dispatch; anything that doesn't need a checkout belongs in
// backend pre/post-ops. See backend/docs/custom-agents.md.

const exec = promisify(execFile)

/**
 * Bring the service's docker-compose dependencies up (local infra only). Best-effort:
 * runs `docker compose -f <path> up -d --wait` in the checkout. A missing Docker daemon
 * or a compose failure is logged and surfaced to the agent (as a prompt note) rather
 * than failing the job — the agent can still run unit-level tests and report what it
 * could. A no-op for ephemeral / no-infra / no-compose-path runs.
 *
 * Whether it succeeds or fails, the (redacted, bounded) command output is captured into a
 * {@link InfraSetupRecord} returned alongside the prompt `note`, so the backend can surface
 * the in-container dependency stand-up logs on the Tester step — the failure-class artifact
 * the orchestrator-side provisioning logs can't see.
 */
async function standUpInfra(
  dir: string,
  infra: ServiceInfraSpec,
  signal: AbortSignal | undefined,
  logger: Logger,
): Promise<{ started: boolean; note?: string; record?: InfraSetupRecord }> {
  if (infra.environment !== 'local' || infra.noInfraDependencies || !infra.composePath) {
    return { started: false }
  }
  const startedAt = Date.now()
  try {
    logger.info('agent(explore): standing up infra', { composePath: infra.composePath })
    // Raise maxBuffer well above the 1MB default so a chatty compose stand-up can't fail the
    // (best-effort) infra step with ENOBUFS; the captured output is tail-bounded on storage.
    const { stdout, stderr } = await exec(
      'docker',
      ['compose', '-f', infra.composePath, 'up', '-d', '--wait'],
      { cwd: dir, signal, timeout: 5 * 60_000, maxBuffer: 16 * 1024 * 1024 },
    )
    const logs = captureRedactedOutput(stdout, stderr)
    return {
      started: true,
      record: {
        started: true,
        composePath: infra.composePath,
        at: Date.now(),
        durationMs: Date.now() - startedAt,
        ...(logs ? { logs } : {}),
      },
    }
  } catch (err) {
    const note = err instanceof Error ? err.message : String(err)
    logger.warn('agent(explore): infra stand-up failed', { error: note })
    // `execFile` rejections carry the partial stdout/stderr on the error object — capture them
    // so the stored logs explain the failure (a port clash, a pull-auth error, an exited
    // dependency), not just the one-line exit message.
    const e = err as { stdout?: unknown; stderr?: unknown }
    const logs = captureRedactedOutput(e.stdout, e.stderr)
    return {
      started: false,
      note,
      record: {
        started: false,
        composePath: infra.composePath,
        at: Date.now(),
        durationMs: Date.now() - startedAt,
        error: redactSecrets(note),
        ...(logs ? { logs } : {}),
      },
    }
  }
}

/**
 * Stand the run's infra up and return a single cleanup handle, dispatching on the spec's
 * `kind`: the frontend UI-test flow (`kind: 'frontend'`) builds/serves the app + WireMock as
 * processes (torn down by killing them); the default backend-service flow stands the
 * docker-compose stack up (torn down with `docker compose down`). Unifying the two here keeps
 * `runExploreMode` free of the branch and guarantees the matching teardown runs in its finally.
 *
 * `dir` is the clone ROOT; `workDir` is the service subtree (equal to `dir` when the run is not
 * monorepo-scoped). The docker-compose stand-up runs at the root (its `composePath` is
 * repo-relative), but the FRONTEND stand-up runs in `workDir`: a monorepo frontend's
 * `package.json` / `outputDir` / `mocks/` all live under the service subtree, so installing,
 * building, serving and seeding WireMock from the root would target the wrong directory.
 */
async function manageInfra(
  dir: string,
  workDir: string,
  infra: AgentInfraSpec,
  signal: AbortSignal | undefined,
  onActivity: (() => void) | undefined,
  logger: Logger,
): Promise<{
  note?: string
  serveUrl?: string
  record?: InfraSetupRecord
  cleanup: () => Promise<void>
}> {
  if (infra.kind === 'frontend') {
    // `onActivity` feeds the inactivity watchdog through the frontend build/serve stand-up,
    // which (unlike docker-compose's 5-min-capped `up`) can run past the inactivity window.
    // Runs in `workDir` so a monorepo frontend builds/serves from its own package subtree.
    const fe = await standUpFrontend(workDir, infra, signal, onActivity, logger)
    return {
      ...(fe.note ? { note: fe.note } : {}),
      ...(fe.serveUrl ? { serveUrl: fe.serveUrl } : {}),
      record: fe.record,
      cleanup: () => tearDownFrontend(fe.processes, logger),
    }
  }
  const standUp = await standUpInfra(dir, infra, signal, logger)
  return {
    ...(standUp.note ? { note: standUp.note } : {}),
    ...(standUp.record ? { record: standUp.record } : {}),
    cleanup: () => tearDownInfra(dir, infra),
  }
}

/**
 * Build the dynamic infra notes appended to the agent's user prompt from a stand-up outcome.
 * A stand-up problem (a failed build / compose) is flagged as a concern to test around; a
 * frontend serve URL points the UI tester at the app that was just built + served and pre-empts
 * a live-backend CORS failure being mis-reported as an app defect. Pure (no IO) so the exact
 * wording + ordering is unit-tested; returns the notes in order (problem first, serve URL next).
 */
export function buildInfraNotes(managed: { note?: string; serveUrl?: string }): string[] {
  const notes: string[] = []
  if (managed.note) {
    notes.push(
      `standing the infra up reported a problem (${managed.note}). Test what you can and ` +
        `flag any dependency-related gaps as concerns.`,
    )
  }
  if (managed.serveUrl) {
    notes.push(
      `The frontend under test is built and served at ${managed.serveUrl}, with its other ` +
        `backend upstreams handled by WireMock. Drive your UI tests against ${managed.serveUrl}. ` +
        `If a call to a live backend fails with a CORS / cross-origin error, that is an infra ` +
        `gap (the backend must allow the ${managed.serveUrl} origin), not an app defect — flag ` +
        `it as a concern rather than a failing test.`,
    )
  }
  return notes
}

/** Tear the docker-compose dependencies down (best-effort; a no-op when none were started). */
async function tearDownInfra(dir: string, infra: ServiceInfraSpec): Promise<void> {
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
  const logger = opts.log ?? log
  return acquireRepoCheckout(
    { persistent: job.persistentCheckout === true, prefix: 'agent-explore', repo: job.repo },
    async (dir) => {
      opts.onPhase?.('clone')
      if (job.persistentCheckout) {
        logger.info('agent(explore): preparing reused checkout')
        await prepareExistingCheckout({
          dir,
          repo: job.repo,
          ghToken: job.ghToken,
          branch: job.branch,
          baseBranch: job.branch,
          existing: true,
          signal: opts.signal,
        })
      } else {
        logger.info('agent(explore): cloning')
        await cloneRepo({
          repo: { ...job.repo, baseBranch: job.branch },
          ghToken: job.ghToken,
          dir,
          full: job.full,
          signal: opts.signal,
        })
      }

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
      const managed = infra
        ? await manageInfra(dir, workDir, infra, opts.signal, opts.onActivity, logger)
        : undefined
      // Fold the stand-up outcome into the agent prompt: a stand-up problem (build/compose
      // failure) is flagged as a concern; a frontend serve URL points the UI tester at the
      // app it just built + served (the backend env resolution already reached the harness).
      const infraNotes = managed ? buildInfraNotes(managed) : []
      const userPrompt = infraNotes.length
        ? `${job.userPrompt}\n\nNote: ${infraNotes.join(' ')}`
        : job.userPrompt
      // The stand-up record (success or failure, with its captured logs) rides back on EVERY
      // result branch — the backend surfaces it on the Tester step regardless of whether the
      // agent then produced a usable report.
      const infraSetupFields: { infraSetup?: InfraSetupRecord } = managed?.record
        ? { infraSetup: managed.record }
        : {}

      try {
        opts.onPhase?.('agent')
        logger.info('agent(explore): running agent', { serviceDirectory })
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
            ambientAuth: job.ambientAuth,
            proxyBaseUrl: job.proxyBaseUrl,
            sessionToken: job.sessionToken,
            serviceDirectory,
            // Read-only: it inspects and reports, making no edits — so the no-progress
            // guard's no-edit bound must not fire on its legitimately edit-free run.
            expectsEdits: false,
            webToolsGuidance: job.webToolsGuidance,
            webSearchProxy: job.webSearch,
            contextFiles: job.contextFiles,
            guardLimits: job.guardLimits,
          },
          opts,
        )

        if (!summary.trim()) {
          return {
            summary,
            stats,
            error: noOutputReason(stats, stderrTail),
            failureCause: 'no-usable-output',
            ...(usage ? { usage } : {}),
            ...infraSetupFields,
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
              failureCause: 'no-usable-output',
              ...(usage ? { usage } : {}),
              ...infraSetupFields,
            }
          }
        }

        // Prose: the summary IS the deliverable.
        if (job.output?.kind !== 'structured') {
          logger.info('agent(explore): done (prose)', { ...stats })
          return { summary, stats, ...(usage ? { usage } : {}), ...infraSetupFields }
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
            failureCause: 'no-usable-output',
            ...(usage ? { usage } : {}),
            ...infraSetupFields,
          }
        }
        // Stamp the run's actual environment authoritatively onto the structured result when
        // infra was managed (the tester): which env the suite ran in is decided by the job's
        // infra spec, NOT the model, so the backend can echo it back to the UI deterministically
        // even when the model omits it from its JSON (or a structured repair drops it). A
        // frontend run tests the app against its live ephemeral backend(s), so it reports
        // `ephemeral` (the TestReport env vocabulary has no separate frontend value).
        const reportedEnvironment = infra
          ? infra.kind === 'frontend'
            ? 'ephemeral'
            : infra.environment
          : undefined
        if (reportedEnvironment && typeof custom === 'object') {
          ;(custom as Record<string, unknown>).environment = reportedEnvironment
        }
        logger.info('agent(explore): done (structured)', { ...stats })
        return { summary, custom, stats, ...(usage ? { usage } : {}), ...infraSetupFields }
      } finally {
        if (managed) await managed.cleanup()
      }
    },
  )
}

/**
 * Edit-and-push coding: clone `branch` (or resume `newBranch`), run the agent, commit +
 * push to `pushBranch`, and open `pr` when one is set and the run produced changes. A
 * no-op is a failure for the implementer (`noChangesIsError` default) and a non-fatal
 * no-op for the in-place fixers.
 */
async function runCodingMode(job: AgentJob, opts: RunOptions): Promise<AgentResult> {
  // Repo bootstrap is a coding run that force-pushes a fresh history to a SEPARATE target
  // repo (clone + adapt a reference, or scaffold from scratch). Keyed off job DATA
  // (`bootstrap`), not the agent kind.
  if (job.bootstrap) return runBootstrap(job, opts)
  // Conflict resolution is a coding run with a different pre/post around the agent:
  // clone full, merge the base in to surface the conflicts, then complete the merge
  // commit + push (no PR). Keyed off job DATA (`mergeBase`), not the agent kind.
  if (job.mergeBase) return runConflictResolution(job, opts)

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
      ambientAuth: job.ambientAuth,
      proxyBaseUrl: job.proxyBaseUrl,
      sessionToken: job.sessionToken,
      commitMessage: job.commitMessage ?? job.pr?.title ?? 'Agent changes',
      webToolsGuidance: job.webToolsGuidance,
      webSearchProxy: job.webSearch,
      guardLimits: job.guardLimits,
      ...(job.persistentCheckout ? { persistentCheckout: true } : {}),
      ...(job.streamFollowUps ? { streamFollowUps: true } : {}),
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
      failureCause: 'no-changes',
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
      // The provider (set by the server from the configured backend) selects GitHub-PR vs
      // GitLab-MR authoritatively; the clone URL supplies the GitLab REST base + project path.
      // The harness's git auth is already host-neutral.
      cloneUrl: job.repo.cloneUrl,
      ...(job.repo.provider ? { provider: job.repo.provider } : {}),
      signal: opts.signal,
    })
    return { pushed: true, prUrl, branch: pushBranch, summary, stats, ...(usage ? { usage } : {}) }
  }
  return { pushed: true, branch: pushBranch, summary, stats, ...(usage ? { usage } : {}) }
}

/**
 * Conflict-resolution coding flow (the conflict-resolver): clone the PR head `branch`
 * (full history), merge `origin/<mergeBase>` into it to surface the Git conflicts, run
 * the agent to resolve them, then complete the merge commit and push back onto the SAME
 * branch (no new branch / PR) so the PR becomes mergeable and CI re-runs. Diverges from
 * the ordinary coding flow only in needing a full clone, a base→branch merge to produce
 * the conflicts, the conflict hunks surfaced into the prompt, and a guard that refuses to
 * push a half-resolved tree.
 */
async function runConflictResolution(job: AgentJob, opts: RunOptions): Promise<AgentResult> {
  const { signal } = opts
  const mergeBase = job.mergeBase!
  const logger = opts.log ?? log
  return withWorkspace('conflict', async (dir) => {
    opts.onPhase?.('clone')
    logger.info('agent(conflict): cloning PR branch (full history)')
    // Full clone so the merge base + `origin/<mergeBase>` are present for the merge.
    await cloneRepo({
      repo: { ...job.repo, baseBranch: job.branch },
      ghToken: job.ghToken,
      dir,
      signal,
      full: true,
    })
    const prTip = await headCommit(dir, signal)

    logger.info('agent(conflict): merging base into PR branch', { base: mergeBase })
    const clean = await mergeBranch(dir, mergeBase, signal)

    // No conflicts to resolve. If base brought new commits the merge advanced the branch,
    // so push it; otherwise the branch is already up to date — a no-op we leave alone (a
    // gate that keeps seeing GitHub report this branch as "conflicting" is then a
    // base-resolution problem, not the agent's — logged so that loop is diagnosable).
    if (clean) {
      if ((await headCommit(dir, signal)) === prTip) {
        logger.info('agent(conflict): base merged clean and branch already up to date', {
          base: mergeBase,
        })
        return {
          pushed: false,
          branch: job.branch,
          summary: 'No conflicts: the branch is already up to date with its base.',
          stats: { toolCalls: 0, assistantChars: 0 },
        }
      }
      opts.onPhase?.('push')
      logger.info('agent(conflict): base merged clean — pushing the merge commit')
      await pushBranch(dir, job.branch, job.ghToken, signal)
      return {
        pushed: true,
        branch: job.branch,
        summary: 'Merged the base in cleanly (no conflicts to resolve).',
        stats: { toolCalls: 0, assistantChars: 0 },
      }
    }

    // The merge left conflicts in the working tree. Surface the EXACT files + hunks to the
    // agent: the generic task prompt alone never told it which files conflict (or even that
    // there were conflicts), so it would drift onto the original feature task. Lead with the
    // conflict; keep the task only as trailing reference.
    const conflicted = await unmergedPaths(dir, signal)
    opts.onPhase?.('agent')
    logger.info('agent(conflict): resolving conflicts with agent', { conflicted })
    const diff = await conflictDiff(dir, conflicted, signal)
    const userPrompt = buildConflictPrompt(mergeBase, job.branch, conflicted, diff, job.userPrompt)

    const { summary, stats, stderrTail, usage } = await runAgentInWorkspace(
      {
        dir,
        systemPrompt: job.systemPrompt,
        userPrompt,
        model: job.model,
        harness: job.harness,
        subscriptionToken: job.subscriptionToken,
        subscriptionBaseUrl: job.subscriptionBaseUrl,
        ambientAuth: job.ambientAuth,
        proxyBaseUrl: job.proxyBaseUrl,
        sessionToken: job.sessionToken,
        contextFiles: job.contextFiles,
        guardLimits: job.guardLimits,
      },
      opts,
    )

    // Never push a half-resolved tree: if any conflict markers / unmerged paths remain,
    // the PR would still be broken. Fail so the engine can retry / notify.
    const unresolved = await unmergedPaths(dir, signal)
    if (unresolved.length > 0) {
      logger.error('agent(conflict): unresolved conflicts remain, refusing to push', {
        unresolved: unresolved.length,
      })
      return {
        pushed: false,
        branch: job.branch,
        summary,
        stats,
        error: unresolvedReason(unresolved, stats, stderrTail),
        failureCause: 'agent',
        ...(usage ? { usage } : {}),
      }
    }
    // Complete the merge commit with the agent's resolution staged, then push.
    await commitAll(dir, `Merge ${mergeBase} into ${job.branch}`, signal)
    opts.onPhase?.('push')
    logger.info('agent(conflict): pushing resolved branch', { ...stats })
    await pushBranch(dir, job.branch, job.ghToken, signal)
    return { pushed: true, branch: job.branch, summary, stats, ...(usage ? { usage } : {}) }
  })
}

/**
 * The conflict-focused user prompt: lead with the exact conflicted files and their hunks
 * (so the model acts on the real conflict, not the original feature task), then carry the
 * task only as trailing reference. The role/system prompt frames it as a merge-conflict
 * resolution; this gives it the concrete material.
 */
function buildConflictPrompt(
  baseBranch: string,
  prBranch: string,
  conflicted: string[],
  diff: string,
  taskReference: string,
): string {
  const fileList = conflicted.map((p) => `- ${p}`).join('\n')
  const parts = [
    `The base branch \`${baseBranch}\` was merged into this pull-request branch ` +
      `\`${prBranch}\` and left Git merge conflicts in the following ${conflicted.length} ` +
      `file(s):`,
    '',
    fileList,
    '',
    'Resolve EVERY conflict in these files: open each one, understand both sides of each ' +
      '`<<<<<<<` / `=======` / `>>>>>>>` region, and edit it to a correct result that ' +
      "preserves the intent of BOTH the base changes and this PR's changes — never just " +
      'discard one side. Remove every conflict marker and leave the project building. Do ' +
      'not create a new branch or PR; the harness completes the merge commit and pushes once ' +
      'no conflict markers remain.',
    '',
    'Conflict hunks (`git diff` of the conflicted files):',
    '',
    '```diff',
    diff,
    '```',
  ]
  const ref = taskReference.trim()
  if (ref) {
    parts.push('', 'For reference, the task this pull request implements:', '', ref)
  }
  return parts.join('\n')
}

/** Human-readable reason the agent failed to fully resolve the conflicts. */
function unresolvedReason(
  unresolved: string[],
  stats: PiRunStats,
  stderrTail: string | undefined,
): string {
  const cause = agentNeverActed(stats) ? NEVER_ACTED_CAUSE : ''
  const sample = unresolved.slice(0, 10).join(', ')
  return (
    `The agent did not resolve all merge conflicts ` +
    `(${unresolved.length} file(s) still conflicted: ${sample}).${cause}` +
    agentOutputTail(stderrTail)
  )
}

/**
 * Repo-bootstrap coding flow (the bootstrapper): with a reference architecture, clone it →
 * the agent adapts it in place per the instructions; without one (`fromScratch`), start from
 * an empty directory → the agent scaffolds the new service. Either way the result's history
 * is reset to a single commit and force-pushed to the SEPARATE, pre-created target repo's
 * default branch. Diverges from the ordinary coding flow in pushing to a different repo with
 * a reinitialised history rather than a work branch + PR on the cloned repo.
 */
async function runBootstrap(job: AgentJob, opts: RunOptions): Promise<AgentResult> {
  const { signal } = opts
  const boot = job.bootstrap!
  const fromScratch = boot.fromScratch === true
  const logger = (opts.log ?? log).child({ target: `${boot.target.owner}/${boot.target.name}` })
  return withWorkspace('boot', async (dir) => {
    if (!fromScratch) {
      opts.onPhase?.('clone')
      logger.info('agent(bootstrap): cloning reference architecture', {
        reference: `${job.repo.owner}/${job.repo.name}`,
      })
      await cloneRepo({
        repo: { ...job.repo, baseBranch: job.branch },
        ghToken: job.ghToken,
        dir,
        signal,
      })
    } else {
      logger.info('agent(bootstrap): scaffolding from scratch (no reference)')
    }

    opts.onPhase?.('agent')
    logger.info('agent(bootstrap): running agent')
    const { summary, stats, stderrTail, usage } = await runAgentInWorkspace(
      {
        dir,
        systemPrompt: job.systemPrompt,
        userPrompt: job.userPrompt,
        model: job.model,
        harness: job.harness,
        subscriptionToken: job.subscriptionToken,
        subscriptionBaseUrl: job.subscriptionBaseUrl,
        ambientAuth: job.ambientAuth,
        proxyBaseUrl: job.proxyBaseUrl,
        sessionToken: job.sessionToken,
        guardLimits: job.guardLimits,
      },
      opts,
    )

    // Guard against a no-op run: Pi can exit cleanly having done nothing (e.g. it never
    // reached the model), and a force-push would then publish an empty tree — leaving the
    // run "succeeded" but the repo bare. Fail with a structured error (carrying what the
    // agent did) instead of pushing nothing.
    if (!(await producedRepoContent(dir, !fromScratch, signal))) {
      const error = bootstrapNoOpReason(!fromScratch, stats, summary, stderrTail)
      logger.error('agent(bootstrap): agent produced no content, refusing to push', { ...stats })
      return { summary, stats, error, failureCause: 'agent', ...(usage ? { usage } : {}) }
    }

    opts.onPhase?.('push')
    logger.info('agent(bootstrap): pushing bootstrapped contents', { ...stats })
    // Bootstrap always resets history to one commit + force-pushes (the fresh history
    // shares no ancestor with whatever boilerplate the new repo was created with).
    await reinitAndPush({
      dir,
      target: boot.target,
      ghToken: job.ghToken,
      message: fromScratch
        ? 'Bootstrap new repository'
        : `Bootstrap from ${job.repo.owner}/${job.repo.name}`,
    })
    logger.info('agent(bootstrap): complete', { defaultBranch: boot.target.defaultBranch })
    return { defaultBranch: boot.target.defaultBranch, summary, stats, ...(usage ? { usage } : {}) }
  })
}

/**
 * Whether the bootstrapper actually produced repository content, so a no-op run (the agent
 * never reached the model / never wrote anything) is failed rather than force-pushed as an
 * empty repo. With a reference architecture, "produced content" means the agent changed the
 * clone; scaffolding from scratch, it means at least one file now exists in the working
 * directory. (The harness writes its prompt context to Pi's global `~/.pi/agent/AGENTS.md`,
 * never into `dir`, so nothing here needs to be filtered out as harness boilerplate.)
 */
export async function producedRepoContent(
  dir: string,
  hasReference: boolean,
  signal?: AbortSignal,
): Promise<boolean> {
  if (hasReference) return hasAgentChanges(dir, signal)
  return containsAnyFile(dir)
}

/**
 * Whether `dir` contains at least one regular file anywhere in its tree, walking
 * depth-first and stopping at the FIRST file found — so the cost is bounded by how
 * quickly a file turns up (a scaffold almost always writes a root-level file), not by
 * the size of the produced tree (a full recursive `readdir` would materialise every
 * entry before the check).
 */
async function containsAnyFile(dir: string): Promise<boolean> {
  const handle = await opendir(dir)
  try {
    for await (const entry of handle) {
      if (entry.isFile()) return true
      if (entry.isDirectory() && (await containsAnyFile(join(dir, entry.name)))) return true
    }
  } catch {
    // A directory that vanished mid-walk has nothing to contribute.
  }
  return false
}

/** Human-readable bootstrap no-op reason, embedding what the agent did so the cause is visible. */
function bootstrapNoOpReason(
  hasReference: boolean,
  stats: PiRunStats,
  summary: string,
  stderrTail: string | undefined,
): string {
  const what = hasReference
    ? 'made no changes to the reference architecture'
    : 'scaffolded no files'
  const cause = agentNeverActed(stats) ? NEVER_ACTED_CAUSE : ''
  return (
    `the bootstrapper agent ${what} ` +
    `(tool calls: ${stats.toolCalls}, assistant output: ${stats.assistantChars} chars).${cause}` +
    agentOutputTail(stderrTail, summary)
  )
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
