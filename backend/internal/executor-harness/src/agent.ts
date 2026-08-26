import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import type {
  AgentInfraSpec,
  AgentJob,
  AgentResult,
  InfraSetupRecord,
  ServiceInfraSpec,
  TestSecretSpec,
} from './job.js'
// The preview mode drives the frontend stand-up directly rather than through `manageInfra`:
// its serve/WireMock children outlive the job on purpose, so it wants no cleanup handle.
import { standUpFrontend, tearDownFrontend } from './frontend-infra.js'
import { buildInfraNotes, manageInfra } from './infra-standup.js'
import { artifactUploadEnv } from './artifact-upload.js'
import { configurePackageRegistries } from './package-registries.js'
import { registerKnownSecrets } from './redact.js'
import {
  cloneRepo,
  commitAll,
  conflictDiff,
  fetchPullRequestHead,
  fetchReferenceBranches,
  headCommit,
  mergeBranch,
  prepareExistingCheckout,
  pushBranch,
  unmergedPaths,
} from './git.js'
import { inferVcsProvider, openPullRequest } from './vcs-api.js'
import type { PiRunStats, RunDiagnostics } from './pi-reduction.js'
import { applyPrDescription } from './pr-description.js'
import { makeDirClaimer } from './checkout-dir.js'
import { noChangesReason, runCodingAgent } from './coding-agent.js'
import { runMultiRepoCoding } from './multi-repo-coding.js'
import { validationFailureMessage } from './validation-checks.js'
import { prepopulateDependencies, withDependencyNote } from './dependency-install.js'
import { agentCapabilities, mergeEffort } from './agent-shared.js'
import { runBootstrap } from './bootstrap-mode.js'
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
import { extractJsonObject } from './json-reply.js'
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

/**
 * Parse an agent's final reply into the structured JSON `custom`, shared by the explore and
 * coding structured-output paths. With repair enabled (default) a malformed reply gets ONE
 * structured repair call before giving up; with `output.repair === false` it parses directly.
 * Returns the parsed value (or null when unusable) plus the repair diagnostics. Never throws —
 * a parse failure is a null value, and each caller decides whether that is fatal (explore: yes;
 * coding: no, the pushed commits are the deliverable).
 */
async function resolveReplyCustom(
  job: AgentJob,
  summary: string,
  signal: AbortSignal | undefined,
): Promise<{ value: unknown; diagnostics?: StructuredOutputDiagnostics }> {
  if (job.output?.repair === false) {
    try {
      return { value: extractJsonObject(summary) }
    } catch {
      return { value: null }
    }
  }
  const resolved = await resolveStructuredOutput(
    {
      label: 'agent',
      shapeHint: job.output?.shapeHint ?? 'Expected a single JSON object.',
      parse: (text) => extractJsonObject(text),
    },
    summary,
    {
      harness: job.harness,
      subscriptionToken: job.subscriptionToken,
      subscriptionBaseUrl: job.subscriptionBaseUrl,
      proxyBaseUrl: job.proxyBaseUrl,
      proxyPhasePath: job.proxyPhasePath,
      sessionToken: job.sessionToken,
      model: job.model,
      jobId: job.jobId,
      signal,
    },
  )
  return { value: resolved.value, diagnostics: resolved.diagnostics }
}

/**
 * The service work directory for a checkout at `dir`: the monorepo service subtree
 * (`repo.serviceDirectory`, created if missing) when the job is service-scoped, else the clone
 * root. Shared so the explore/preview flows derive `workDir` identically.
 */
async function deriveWorkDir(dir: string, serviceDirectory: string | undefined): Promise<string> {
  const workDir = serviceDirectory ? join(dir, serviceDirectory) : dir
  if (serviceDirectory) await mkdir(workDir, { recursive: true })
  return workDir
}

/**
 * Fresh-clone `job.branch` into `dir` and return the derived service work directory. Shared by
 * the explore and preview flows, which both start from a clean single-branch checkout. (The
 * coding and persistent-checkout paths keep their own resume / full-clone logic.)
 */
async function cloneServiceCheckout(
  dir: string,
  job: AgentJob,
  signal: AbortSignal | undefined,
): Promise<string> {
  await cloneRepo({
    repo: { ...job.repo, baseBranch: job.branch },
    ghToken: job.ghToken,
    dir,
    full: job.full,
    signal,
  })
  return deriveWorkDir(dir, job.repo.serviceDirectory)
}

/** Run one generic agent job end to end, dispatching on `mode`. */
export async function handleAgent(job: AgentJob, opts: RunOptions = {}): Promise<AgentResult> {
  // An `ambientAuth` job runs in the SHARED native host process on the developer's own HOME
  // (see `LocalProcessRunnerTransport`), so anything this job would otherwise write to a
  // process- or HOME-global gets a per-job directory instead — it can't corrupt the
  // developer's files, and concurrent jobs can't race on them.
  const scopeDir = job.ambientAuth ? await mkdtemp(join(tmpdir(), 'cf-jobenv-')) : undefined
  try {
    // Private-registry auth first, before any mode runs: every mode with a checkout may
    // install dependencies (the agent's own shell and the frontend-infra stand-up both
    // inherit this env, so they all read the written npmrc). In a container a job with no
    // entries clears any stale ~/.npmrc from a prior job on a reused (warm-pool) container.
    const registryEnv = await configurePackageRegistries(
      job.packageRegistries,
      scopeDir ? { isolatedDir: scopeDir } : {},
    )
    // The credentials of this job's GENERATIVE BINARY INTEGRATIONS, layered on for EVERY mode
    // rather than inside one of them: the kinds that carry the `binary-output` trait are a
    // deployment's own and may be explore or coding agents, and a key delivered to one mode and
    // not the other would be an integration that works or 401s depending on how its step was
    // registered. Per-job env like everything else here — never `process.env`, which the shared
    // native host process makes a cross-job leak.
    // The platform's own artifact ingest, layered on for EVERY mode for the same reason: which
    // kinds get the seam is the backend's call (it keys off the kind's declared `ui` image), so a
    // mode check here would be that decision made twice, in the half that cannot see the registry.
    const scoped = withAgentEnv(opts, {
      ...registryEnv,
      ...secretEnv(job.capabilitySecrets),
      ...artifactUploadEnv(job.artifactUpload),
    })
    if (job.mode === 'preview') return await runPreviewMode(job, scoped)
    return job.mode === 'coding'
      ? await runCodingMode(job, scoped)
      : await runExploreMode(job, scoped)
  } finally {
    if (scopeDir) await rm(scopeDir, { recursive: true, force: true }).catch(() => {})
  }
}

/**
 * Layer extra child-process env onto a job's {@link RunOptions}. The agent CLI is spawned with
 * `agentChildEnv(agentEnv)`, so this is how per-job values reach the agent (and the shell tools it
 * spawns) WITHOUT mutating the harness's own `process.env` — which is shared by every concurrent
 * job when the harness runs as a native host process. Empty `env` ⇒ `opts` unchanged.
 */
function withAgentEnv(opts: RunOptions, env: Record<string, string>): RunOptions {
  if (Object.keys(env).length === 0) return opts
  return { ...opts, agentEnv: { ...opts.agentEnv, ...env } }
}

/**
 * Decide a preview stand-up's outcome from its result (pure, so the success/failure boundary
 * is unit-tested without spawning a build). A preview must actually come up: unlike the tester's
 * "test what you can" fallback, a stand-up that produced no reachable serve URL (failed build /
 * server never bound) is a hard failure and its `note` becomes the failure reason. When the app
 * is up but WireMock is not, the `note` rides along as a non-fatal warning.
 */
export function buildPreviewOutcome(standUp: {
  serveUrl?: string
  note?: string
}): { ok: true; url: string; note?: string } | { ok: false; error: string } {
  if (!standUp.serveUrl) {
    return {
      ok: false,
      error: standUp.note
        ? `the frontend preview did not come up (${standUp.note})`
        : 'the frontend preview did not come up (the served app was never reachable)',
    }
  }
  return { ok: true, url: standUp.serveUrl, ...(standUp.note ? { note: standUp.note } : {}) }
}

/**
 * Long-lived browsable preview (local/node only): clone the frontend branch, then build +
 * serve the app with its other upstreams mocked using the SAME {@link standUpFrontend} the UI
 * tester uses — but KEEP IT RUNNING. No agent runs, and the serve / WireMock child processes
 * are deliberately NOT torn down when the job returns, so the app stays reachable inside the
 * container until the container itself is stopped (the transport's explicit stop path). Because
 * the served files must outlive the job, the checkout is cloned into a directory that is NOT
 * auto-removed (unlike the explore/coding `withWorkspace`); the ephemeral preview container
 * reclaims it on teardown. A preview that never comes up is a hard failure — the partial
 * stand-up is torn down and its temp checkout removed so a failed attempt leaks nothing.
 */
async function runPreviewMode(job: AgentJob, opts: RunOptions): Promise<AgentResult> {
  const logger = opts.log ?? log
  const infra = job.infra
  if (infra?.kind !== 'frontend') {
    // Invalid dispatch (a preview job MUST carry the frontend infra spec). No checkout or
    // processes exist yet, so return the structured hard failure the rest of this flow uses
    // rather than throwing a bare exception at the job registry.
    return {
      error: "invalid preview job: 'infra.kind' must be 'frontend'",
      failureCause: 'no-usable-output',
    }
  }
  opts.onPhase?.('clone')
  logger.info('agent(preview): cloning')
  // Not a `withWorkspace` temp dir: that is removed in a `finally` the moment this function
  // returns, which would delete the files the kept-alive server serves. The preview container
  // is single-purpose and torn down on stop, so leaving the checkout in place is intended.
  const dir = await mkdtemp(join(tmpdir(), 'agent-preview-'))
  try {
    const workDir = await cloneServiceCheckout(dir, job, opts.signal)

    opts.onPhase?.('serve')
    logger.info('agent(preview): building + serving', {
      serviceDirectory: job.repo.serviceDirectory,
    })
    const fe = await standUpFrontend(workDir, infra, opts, logger)
    const infraSetupFields: { infraSetup?: InfraSetupRecord } = fe.record
      ? { infraSetup: fe.record }
      : {}
    const outcome = buildPreviewOutcome(fe)
    if (!outcome.ok) {
      // Never came up: tear the partial stand-up down and drop the checkout so a failed preview
      // leaks neither processes nor disk. The backend surfaces the stand-up record + failure.
      await tearDownFrontend(fe.processes, logger)
      await rm(dir, { recursive: true, force: true })
      return { error: outcome.error, failureCause: 'no-usable-output', ...infraSetupFields }
    }
    // Deliberately NOT torn down: the serve/WireMock children outlive this job and keep the app
    // reachable until the container is stopped. `outcome.note` (WireMock down) is a soft warning.
    logger.info('agent(preview): serving (kept alive)', { url: outcome.url })
    return {
      summary: outcome.note
        ? `Frontend preview built and served at ${outcome.url} (${outcome.note}).`
        : `Frontend preview built and served at ${outcome.url}.`,
      preview: { url: outcome.url },
      ...infraSetupFields,
    }
  } catch (err) {
    // A throw BEFORE the stand-up handed off (a failed / aborted clone, an mkdir error) would
    // otherwise leak the checkout that `withWorkspace` normally reclaims — no serve processes
    // are running yet, so drop the dir and rethrow for the job registry to record the failure.
    await rm(dir, { recursive: true, force: true })
    throw err
  }
}

/**
 * Build the env carrying the tester's sensitive secrets, so the agent's shell tools (spawned as
 * child processes that inherit it) can read `$KEY` — the out-of-band delivery channel. Each value
 * is registered for redaction so it can't leak into captured output/logs. Reserved/toolchain env
 * names were already dropped at parse. No secrets ⇒ an empty env.
 *
 * Returned as EXPLICIT child env rather than written onto `process.env`: a process-global
 * set/restore is only safe when the process runs one job, which the native host-process transport
 * breaks (it serves every concurrent ambient job from one process). There, two overlapping tester
 * runs would read each other's secrets, and whichever finished first would delete the other's
 * mid-run. Scoping them to the spawn env makes the delivery correct under concurrency and drops
 * the restore step entirely.
 */
export function testSecretEnv(secrets: TestSecretSpec[] | undefined): Record<string, string> {
  return secretEnv(secrets)
}

/**
 * The shared `{ key, value }[]` → child-env projection behind {@link testSecretEnv} and the
 * generative integrations' credentials. One implementation because both channels owe the same two
 * things — the values registered for redaction, and the env returned rather than written to
 * `process.env` — and a second copy is a second place to forget the redaction.
 */
export function secretEnv(secrets: TestSecretSpec[] | undefined): Record<string, string> {
  if (!secrets?.length) return {}
  registerKnownSecrets(secrets.map((s) => s.value))
  return Object.fromEntries(secrets.map(({ key, value }) => [key, value]))
}

/**
 * Which refs a REUSED (warm-pool) explore checkout must end up holding: the branch to explore, and
 * the repo's own base branch beside it.
 *
 * Its own function, and named, because the bug it removes is a swap between two branch names both
 * in scope at the call site, and nothing downstream can tell them apart. A read-only reviewer's
 * whole instruction is `git diff origin/<base>...HEAD`, so the base ref has to be as fresh as the
 * branch: passing the explored branch as the base collapses the two refspecs into one, leaves
 * `origin/<base>` at whatever tip the pool dir was first cloned at, and moves the merge base back
 * to that tip. The diff then reports every commit merged into base since as part of the change
 * under review, which is wrong in the direction nothing notices.
 */
export function exploreCheckoutRefs(job: Pick<AgentJob, 'branch' | 'repo'>): {
  branch: string
  baseBranch: string
} {
  return { branch: job.branch, baseBranch: job.repo.baseBranch }
}

/**
 * Read-only exploration: clone `branch`, run the agent making no edits, and return its
 * prose report — or, when `output.kind==='structured'`, the parsed JSON object as
 * `custom` (the backend renders any artifact files from it in a post-op). An edit-free
 * run is the expected, correct outcome; the only failure is producing no usable output.
 */
async function runExploreMode(job: AgentJob, opts: RunOptions): Promise<AgentResult> {
  const logger = opts.log ?? log
  // Multi-repo read-only exploration (service-connections phase 3): when the job carries peer
  // repos, clone them all as siblings and run at the workspace root. Keyed off job DATA
  // (`peerRepos`), not the agent kind — the backend sets it for the bug-investigator when the
  // task has involved services in distinct repos. `runMultiRepoExplore` uses its own ephemeral
  // `withWorkspace`, so a `persistentCheckout` flag (which a warm-pool dispatch injects on EVERY
  // job) is harmlessly ignored — it must NOT suppress the fan-out, or a pooled bug-investigator
  // would silently drop its peer repos and only ever see the primary one.
  if (job.peerRepos?.length) return runMultiRepoExplore(job, opts)
  return acquireRepoCheckout(
    { persistent: job.persistentCheckout === true, prefix: 'agent-explore', repo: job.repo },
    async (dir) => {
      opts.onPhase?.('clone')
      // Monorepo: run with cwd set to the service subtree (created if missing), mirroring the
      // coding flow so a service-scoped exploration sees the right subdirectory.
      const serviceDirectory = job.repo.serviceDirectory
      let workDir: string
      if (job.persistentCheckout) {
        logger.info('agent(explore): preparing reused checkout')
        // Both refs, resolved by {@link exploreCheckoutRefs}: which one is the base is the whole
        // decision, so it is made there rather than inline here.
        //
        // `job.full` is deliberately not consulted: the fresh-clone leg inside
        // `prepareExistingCheckout` always clones with full history, so a reused checkout already
        // has the merge base a shallow explore clone would not.
        await prepareExistingCheckout({
          dir,
          repo: job.repo,
          ghToken: job.ghToken,
          ...exploreCheckoutRefs(job),
          existing: true,
          signal: opts.signal,
        })
        workDir = await deriveWorkDir(dir, serviceDirectory)
      } else {
        logger.info('agent(explore): cloning')
        workDir = await cloneServiceCheckout(dir, job, opts.signal)
      }

      // Fetch any read-only reference branches into `origin/<b>` so a read-only agent (architect /
      // analysis / spec-writer) can inspect a prior-art branch without git network credentials of
      // its own. Best-effort per branch; the run makes no commits regardless.
      if (job.referenceBranches?.length) {
        const fetched = await fetchReferenceBranches({
          dir,
          branches: job.referenceBranches,
          ghToken: job.ghToken,
          signal: opts.signal,
          onSkip: (branch, reason) =>
            logger.warn('agent(explore): reference branch fetch skipped', { branch, reason }),
        })
        logger.info('agent(explore): fetched reference branches', {
          requested: job.referenceBranches.length,
          fetched: fetched.length,
        })
      }

      // The pr-reviewer reviews an EXISTING PR: fetch its HEAD into `origin/pr-head` so the
      // read-only agent can inspect the PROPOSED code — files the PR adds (absent from this base
      // checkout) and the head version of every modified file. The agent holds no git credential
      // of its own, so this harness-side fetch (token out of band) is the only way the head is
      // reachable; the prompt then diffs `origin/<base>...origin/pr-head`. Best-effort: on failure
      // the review proceeds on the base checkout + the injected `.cat-context/pr-diff.md`.
      if (job.reviewPrNumber !== undefined) {
        const provider = job.repo.provider ?? inferVcsProvider(job.repo.cloneUrl)
        const fetched = await fetchPullRequestHead({
          dir,
          number: job.reviewPrNumber,
          provider,
          ghToken: job.ghToken,
          signal: opts.signal,
          onSkip: (reason) =>
            logger.warn('agent(explore): PR head fetch skipped', {
              number: job.reviewPrNumber,
              provider,
              reason,
            }),
        })
        logger.info('agent(explore): PR head fetch', { number: job.reviewPrNumber, fetched })
      }

      // DEPENDENCY PREPOPULATION, before the agent's first turn. An EXPLORE run is the case this
      // exists for: a reviewer or architect reading a fresh clone can see that a library is
      // depended upon but not what it actually exposes, so it reasons about the manifest instead
      // of the code. Best-effort — the outcome is stated in the prompt either way and never fails
      // the run. Runs in `workDir` so a monorepo service installs from its own subtree.
      //
      // BEFORE the stand-up below, deliberately. The frontend stand-up runs the service's own
      // install and then SERVES what it built: installing after it would pay for a second install
      // and, worse, rewrite the `node_modules` the running app resolves out of. Prepopulation is
      // setup for everything that follows, so it goes first.
      const dependencyNote = await prepopulateDependencies({
        spec: job.dependencyInstall,
        installDir: workDir,
        repoDir: dir,
        agentDir: workDir,
        logger,
        opts,
      })

      // Optional infra stand-up (the tester): bring the service's docker-compose
      // dependencies up at the repo root for the duration of the run, tearing them down in
      // the `finally`. A stand-up failure is non-fatal — it's surfaced to the agent as a
      // prompt note so it can still run what it can and flag dependency gaps as concerns.
      // The run-mode guidance itself lives in the backend-composed system/user prompt; the
      // harness only manages the lifecycle + this dynamic stand-up note.
      const infra = job.infra
      const managed = infra ? await manageInfra(dir, workDir, infra, opts, logger) : undefined
      // Fold the stand-up outcome into the agent prompt: a stand-up problem (build/compose
      // failure) is flagged as a concern; a frontend serve URL points the UI tester at the
      // app it just built + served (the backend env resolution already reached the harness).
      const infraNotes = managed ? buildInfraNotes(managed) : []
      const userPrompt = withDependencyNote(
        infraNotes.length ? `${job.userPrompt}\n\nNote: ${infraNotes.join(' ')}` : job.userPrompt,
        dependencyNote,
      )
      // The stand-up record (success or failure, with its captured logs) rides back on EVERY
      // result branch — the backend surfaces it on the Tester step regardless of whether the
      // agent then produced a usable report.
      const infraSetupFields: { infraSetup?: InfraSetupRecord } = managed?.record
        ? { infraSetup: managed.record }
        : {}

      // Hand the tester's sensitive secrets to the agent's child process (out of band) so its
      // shell can read them as `$KEY`. Scoped to this job's env, so a concurrent job in the same
      // harness process never sees them. A no-op for non-tester runs (no `testSecrets`).
      const agentOpts = withAgentEnv(opts, testSecretEnv(job.testSecrets))

      try {
        opts.onPhase?.('agent')
        logger.info('agent(explore): running agent', { serviceDirectory })
        const {
          summary,
          stats,
          stderrTail,
          usage,
          callMetrics,
          diagnostics: runDiag,
          effortReport,
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
            proxyPhasePath: job.proxyPhasePath,
            sessionToken: job.sessionToken,
            serviceDirectory,
            // Read-only: it inspects and reports, making no edits — so the no-progress
            // guard's no-edit bound must not fire on its legitimately edit-free run.
            expectsEdits: false,
            webToolsGuidance: job.webToolsGuidance,
            webSearchProxy: job.webSearch,
            contextFiles: job.contextFiles,
            guardLimits: job.guardLimits,
            ...agentCapabilities(job),
          },
          agentOpts,
        )

        return mergeEffort(
          await finalizeExploreResult(
            job,
            { summary, stats, stderrTail, usage, callMetrics, runDiag },
            { infra, infraSetupFields, logger, signal: opts.signal },
          ),
          effortReport,
        )
      } finally {
        if (managed) await managed.cleanup()
      }
    },
  )
}

/** The agent-run outputs the explore result-parsing reads (shared single-/multi-repo). */
interface ExploreAgentRun {
  summary: string
  stats: PiRunStats
  stderrTail?: string
  usage?: AgentResult['usage']
  callMetrics?: AgentResult['callMetrics']
  runDiag?: RunDiagnostics
}

/**
 * Turn an explore agent's raw run into an {@link AgentResult}: guard an empty/truncated reply,
 * then either return the prose summary or parse (+ optionally repair) the structured JSON as
 * `custom` — the backend renders any artifact files from it in a post-op. Extracted so the
 * single-repo {@link runExploreMode} and the read-only {@link runMultiRepoExplore} share ONE
 * result contract (the multi-repo path passes no infra, so the tester-only env stamping no-ops).
 */
async function finalizeExploreResult(
  job: AgentJob,
  run: ExploreAgentRun,
  ctx: {
    infra?: AgentInfraSpec | ServiceInfraSpec
    infraSetupFields: { infraSetup?: InfraSetupRecord }
    logger: Logger
    signal?: AbortSignal
  },
): Promise<AgentResult> {
  const { summary, stats, stderrTail, usage, callMetrics, runDiag } = run
  const { infra, infraSetupFields, logger, signal } = ctx

  if (!summary.trim()) {
    return {
      summary,
      stats,
      error: noOutputReason(stats, stderrTail),
      failureCause: 'no-usable-output',
      ...(usage ? { usage } : {}),
      ...(callMetrics ? { callMetrics } : {}),
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
        ...(callMetrics ? { callMetrics } : {}),
        ...infraSetupFields,
      }
    }
  }

  // Prose: the summary IS the deliverable.
  if (job.output?.kind !== 'structured') {
    logger.info('agent(explore): done (prose)', { ...stats })
    return {
      summary,
      stats,
      ...(usage ? { usage } : {}),
      ...(callMetrics ? { callMetrics } : {}),
      ...infraSetupFields,
    }
  }

  // Structured: parse the agent's JSON via the shared resolver. With repair enabled (default)
  // a malformed reply gets ONE structured repair call before giving up; with `repair:false` it
  // parses directly (no repair channel). The backend coerces/validates + renders from the
  // returned object in a post-op. Unlike the coding path, an unparseable explore reply IS a
  // failure — the report/JSON is the whole deliverable.
  const { value: custom, diagnostics } = await resolveReplyCustom(job, summary, signal)
  if (custom === undefined || custom === null) {
    return {
      summary,
      stats,
      error: noStructuredReason(stats, stderrTail, diagnostics),
      failureCause: 'no-usable-output',
      ...(usage ? { usage } : {}),
      ...(callMetrics ? { callMetrics } : {}),
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
  return {
    summary,
    custom,
    stats,
    ...(usage ? { usage } : {}),
    ...(callMetrics ? { callMetrics } : {}),
    ...infraSetupFields,
  }
}

/**
 * Read-only MULTI-REPO exploration (service-connections phase 3, read-only): clone the primary
 * repo PLUS every connected peer repo as SIBLING checkouts under one workspace root, run the
 * agent ONCE with its cwd at the root (so it can read across every repo the bug touches), and
 * return its prose/structured result — making NO edits, NO commits and opening NO PR. The
 * counterpart of {@link runMultiRepoCoding} for the `bug-investigator`, but strictly read-only:
 * peers carry no `newBranch`/`pr`, nothing is pushed, and the peers exist only to be read. The
 * multi-repo layout is explained to the agent by the backend-composed system-prompt section
 * (which repo/subdir each service lives in) + the harness's own AGENTS.md multi-repo note.
 */
async function runMultiRepoExplore(job: AgentJob, opts: RunOptions): Promise<AgentResult> {
  const logger = (opts.log ?? log).child({ kind: 'multi-repo-explore', jobId: job.jobId })
  const peers = job.peerRepos ?? []

  // Unique sibling directory per repo (owner-prefixed on a name collision), so two repos
  // named the same never clobber each other — shared claim scheme with the coding fan-out.
  const claimDir = makeDirClaimer()
  const legs = [
    { repo: job.repo, cloneBranch: job.branch, ghToken: job.ghToken },
    ...peers.map((peer) => ({
      repo: peer.repo,
      // A read-only peer clones at its default branch (the bug-investigator) unless the job pins
      // an explicit branch — the merger checks each peer out at its PR branch so the combined diff
      // sees the PR change (`git diff origin/<base>...HEAD`).
      cloneBranch: peer.cloneBranch ?? peer.repo.baseBranch,
      ghToken: peer.ghToken ?? job.ghToken,
    })),
  ].map((leg) => ({ ...leg, dirName: claimDir(leg.repo) }))

  return withWorkspace('explore-multi', async (root) => {
    // Clone phase: every repo (read-only) into its sibling dir under the workspace root. No
    // work branch, no resume — the agent only reads — so the legs are independent and clone in
    // parallel (wall-clock is the slowest single clone, not the sum). `full` is honoured per the
    // job (the merger needs full history so `git diff origin/<base>...HEAD` has the merge base;
    // the bug-investigator leaves it shallow).
    opts.onPhase?.('clone')
    await Promise.all(
      legs.map(async (leg) => {
        const dir = join(root, leg.dirName)
        await mkdir(dir, { recursive: true })
        logger.info('multi-repo-explore: cloning', {
          repo: leg.dirName,
          cloneBranch: leg.cloneBranch,
        })
        await cloneRepo({
          repo: { ...leg.repo, baseBranch: leg.cloneBranch },
          ghToken: leg.ghToken,
          dir,
          full: job.full,
          signal: opts.signal,
        })
      }),
    )

    // Reference branches attach to the PRIMARY repo (the first leg): fetch them into its sibling
    // checkout's `origin/<b>` refs so the agent can read a prior-art branch. Best-effort per branch.
    if (job.referenceBranches?.length) {
      const primary = legs[0]
      if (primary) {
        const fetched = await fetchReferenceBranches({
          dir: join(root, primary.dirName),
          branches: job.referenceBranches,
          ghToken: primary.ghToken,
          signal: opts.signal,
          onSkip: (branch, reason) =>
            logger.warn('multi-repo-explore: reference branch fetch skipped', { branch, reason }),
        })
        logger.info('multi-repo-explore: fetched reference branches', {
          requested: job.referenceBranches.length,
          fetched: fetched.length,
        })
      }
    }

    // DEPENDENCY PREPOPULATION for the PRIMARY leg. The install is declared on ONE service frame
    // (the primary repo's), so it is run in that leg's checkout — never fanned out across the
    // peers, whose services declare their own configs the dispatch never resolved. The agent runs
    // at the workspace ROOT and reads across every sibling, which is exactly why this matters
    // here: a cross-repo investigator reasoning about a manifest instead of the packages is the
    // complaint that motivated the feature. Same treatment as the reference branches above.
    //
    // The note names the sibling directory rather than saying "this checkout": the agent's cwd is
    // the workspace root, which has no dependency tree of its own.
    const primaryLeg = legs[0]
    const dependencyNote = primaryLeg
      ? await prepopulateDependencies({
          spec: job.dependencyInstall,
          installDir: join(root, primaryLeg.dirName),
          repoDir: join(root, primaryLeg.dirName),
          agentDir: root,
          logger,
          opts,
        })
      : undefined

    opts.onPhase?.('agent')
    logger.info('multi-repo-explore: running agent', { repos: legs.map((l) => l.dirName) })
    const run = await runAgentInWorkspace(
      {
        dir: root,
        systemPrompt: job.systemPrompt,
        userPrompt: withDependencyNote(job.userPrompt, dependencyNote),
        model: job.model,
        harness: job.harness,
        subscriptionToken: job.subscriptionToken,
        subscriptionBaseUrl: job.subscriptionBaseUrl,
        ambientAuth: job.ambientAuth,
        proxyBaseUrl: job.proxyBaseUrl,
        proxyPhasePath: job.proxyPhasePath,
        sessionToken: job.sessionToken,
        // Read-only: no edits expected, so the no-progress guard's no-edit bound must not fire.
        expectsEdits: false,
        webToolsGuidance: job.webToolsGuidance,
        webSearchProxy: job.webSearch,
        ...(job.contextFiles ? { contextFiles: job.contextFiles } : {}),
        guardLimits: job.guardLimits,
        ...agentCapabilities(job),
        multiRepo: true,
      },
      opts,
    )
    return mergeEffort(
      await finalizeExploreResult(
        job,
        {
          summary: run.summary,
          stats: run.stats,
          stderrTail: run.stderrTail,
          usage: run.usage,
          callMetrics: run.callMetrics,
          runDiag: run.diagnostics,
        },
        { infraSetupFields: {}, logger, signal: opts.signal },
      ),
      run.effortReport,
    )
  })
}

/**
 * Whether a Ralph iteration ({@link AgentJob.validation} set) landed on a MULTI-REPO job (writable
 * peer repos or read-only reference repos). The post-commit validation command is only wired into
 * the single-repo flow, so a multi-repo run would silently skip it and degenerate the loop into a
 * one-shot with no completion gate — multi-repo ralph is out of scope for v1 (see
 * backend/docs/ralph-loop.md), so {@link runCodingMode} fails loudly on this instead.
 */
export function ralphUnsupportedOnMultiRepo(
  job: Pick<AgentJob, 'validation' | 'peerRepos' | 'referenceRepos'>,
): boolean {
  return Boolean(job.validation) && Boolean(job.peerRepos?.length || job.referenceRepos?.length)
}

/**
 * Edit-and-push coding, dispatching on job DATA: repo-bootstrap (force-push a fresh history to a
 * separate target repo), conflict-resolution (merge the base in, resolve, push back), multi-repo
 * fan-out (sibling checkouts + one PR per changed repo), else the ordinary single-repo flow.
 * After the flow, a STRUCTURED coding kind (e.g. `repro-test`, whose deliverable is BOTH a pushed
 * commit AND a JSON outcome) parses its final reply into `custom` — best-effort, so an unparseable
 * outcome degrades to no `custom` (the backend resolver then defaults) rather than failing the
 * run, whose real deliverable is the pushed commits.
 */
async function runCodingMode(job: AgentJob, opts: RunOptions): Promise<AgentResult> {
  // Repo bootstrap is a coding run that force-pushes a fresh history to a SEPARATE target
  // repo (clone + adapt a reference, or scaffold from scratch). Keyed off job DATA
  // (`bootstrap`), not the agent kind. Bootstrap/conflict never carry a structured `output`.
  if (job.bootstrap) return runBootstrap(job, opts)
  // Conflict resolution is a coding run with a different pre/post around the agent:
  // clone full, merge the base in to surface the conflicts, then complete the merge
  // commit + push (no PR). Keyed off job DATA (`mergeBase`), not the agent kind.
  if (job.mergeBase) return runConflictResolution(job, opts)
  // Multi-repo coding: clone every additional repo as a sibling and run the agent once across
  // all of them. Keyed off job DATA, not the agent kind — set for the implementer's writable
  // peer repos (service-connections phase 3, `peerRepos`) OR the doc-writer's READ-ONLY
  // reference repos (`referenceRepos`, cloned but never pushed).
  const multiRepo = Boolean(job.peerRepos?.length || job.referenceRepos?.length)
  // Ralph loop (v1): the post-commit validation command is only wired into the single-repo
  // flow, so a multi-repo run would silently skip it and the loop would degenerate into a
  // one-shot with no completion gate. Multi-repo ralph is deliberately out of scope for v1
  // (see backend/docs/ralph-loop.md), so FAIL LOUDLY rather than run a validation-less pass.
  if (ralphUnsupportedOnMultiRepo(job)) {
    return {
      error:
        'Ralph loop is not supported on a multi-repo task (connected service repos). ' +
        'Its validation command runs only in the single primary-repo checkout. ' +
        'Run the Ralph loop on a task scoped to a single repo.',
    }
  }
  const result = multiRepo
    ? await runMultiRepoCoding(job, opts)
    : await runSingleRepoCoding(job, opts)

  // Structured coding kind (repro-test): fold the final reply's JSON onto `custom` so the
  // backend post-completion resolver records the outcome. Skipped on a failed run (its `error`
  // is the signal) and when there is no reply to parse. Best-effort: a null parse leaves
  // `custom` unset (the run still succeeds on its commits).
  if (job.output?.kind === 'structured' && !result.error && result.summary) {
    const { value } = await resolveReplyCustom(job, result.summary, opts.signal)
    if (value !== null && value !== undefined) result.custom = value
  }
  return result
}

/**
 * Assemble the {@link runCodingAgent} spec for the ordinary single-repo coding flow. Extracted
 * from {@link runSingleRepoCoding} so the many optional-field spreads don't inflate that
 * function's cyclomatic complexity; the mapping is a straight field copy off `job`.
 *
 * Exported for the `opensPr` assertion: whether a dispatch fills the repo's PR template turns on
 * this one spread, and the in-place fixers reach it through the SAME function as the implementer,
 * so no structural guard can tell their cases apart.
 */
export function buildSingleRepoCodingSpec(
  job: AgentJob,
  pushBranch: string,
): Parameters<typeof runCodingAgent>[0] {
  return {
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
    proxyPhasePath: job.proxyPhasePath,
    sessionToken: job.sessionToken,
    commitMessage: job.commitMessage ?? job.pr?.title ?? 'Agent changes',
    webToolsGuidance: job.webToolsGuidance,
    webSearchProxy: job.webSearch,
    guardLimits: job.guardLimits,
    ...(job.persistentCheckout ? { persistentCheckout: true } : {}),
    ...(job.streamFollowUps ? { streamFollowUps: true } : {}),
    // The task's linked documents, materialised into `.cat-context/` for the agent to read on
    // demand. Every other caller of `runAgentInWorkspace` forwards these; this spread was the one
    // that did not, so the implementer's prompt named files its checkout had never been given.
    ...(job.contextFiles?.length ? { contextFiles: job.contextFiles } : {}),
    // Whether a pull request will open at all is exactly `job.pr` (see the `if (job.pr)` guard in
    // `runSingleRepoCoding`), and it is what decides whether the repo's PR template is worth
    // resolving. Read off the same field rather than a new job-body flag, so the two can't drift.
    ...(job.pr ? { opensPr: true } : {}),
    ...(job.referenceBranches?.length ? { referenceBranches: job.referenceBranches } : {}),
    // Skills + tool servers: installed/wired harness-aware by runAgentInWorkspace.
    ...agentCapabilities(job),
    // Ralph loop: run the completion command after the agent commits and report its verdict.
    ...(job.validation
      ? {
          validation: {
            command: job.validation.command,
            ...(job.validation.iteration !== undefined
              ? { iteration: job.validation.iteration }
              : {}),
          },
        }
      : {}),
    // Pre-PR validation: the service's check commands, run against the checkout BEFORE the PR
    // opens with failures fed back to the agent (see docs/initiatives/pre-pr-validation.md).
    // Forwarded straight off the job body — the loop is generic machinery keyed on the data, not
    // on the agent kind.
    ...(job.validationChecks ? { validationChecks: job.validationChecks } : {}),
    // Bugfix reproduction proof: the declared command run against the pre-fix and final trees
    // (see docs/initiatives/bugfix-reproduction-proof.md). Forwarded straight off the job body —
    // like the checks above, the loop is generic machinery keyed on the data, not the agent kind.
    ...(job.reproduction ? { reproduction: job.reproduction } : {}),
    // Dependency prepopulation: the service's install, run against the checkout BEFORE the
    // agent's first turn (see docs/initiatives/agent-dependency-prepopulation.md). Forwarded
    // straight off the job body like the two phases above — generic machinery keyed on the data.
    ...(job.dependencyInstall ? { dependencyInstall: job.dependencyInstall } : {}),
  }
}

/**
 * The ordinary single-repo coding flow: clone `branch` (or resume `newBranch`), run the agent,
 * commit + push to `pushBranch`, and open `pr` when one is set and the run produced changes. A
 * no-op is a failure for the implementer (`noChangesIsError` default) and a non-fatal no-op for
 * the in-place fixers (and for a seed-only kind like `repro-test`).
 */
async function runSingleRepoCoding(job: AgentJob, opts: RunOptions): Promise<AgentResult> {
  const pushBranch = job.pushBranch ?? job.newBranch ?? job.branch
  const {
    summary,
    stats,
    stderrTail,
    pushed,
    usage,
    callMetrics,
    validation,
    validationReport,
    reproductionReport,
    effortReport,
    prDescription,
  } = await runCodingAgent(buildSingleRepoCodingSpec(job, pushBranch), opts)
  // Ralph loop: the harness-computed validation verdict, forwarded onto the coding result as
  // `ralphVerdict` so the backend's `toRunResult` lifts it onto `AgentRunResult.ralphVerdict`.
  const ralphVerdict = validation ? { ralphVerdict: validation } : {}
  // The agent's effort self-assessment, spread onto every result path below (mirrors ralphVerdict).
  const effort = effortReport ? { effortReport } : {}
  // The two PRE-PR VERIFICATION reports, spread onto every result path below. The validation one:
  // on the passing path it is the captured proof the checkout was green when the PR opened; on the
  // exhausted path it is the evidence behind the failure below. The reproduction one is evidence
  // on every path — it never gates the PR. Each is absent when its phase was not configured.
  const verificationFields = {
    ...(validationReport ? { validationReport } : {}),
    ...(reproductionReport ? { reproductionReport } : {}),
  }

  // Pre-PR validation spent its attempt budget with the checkout still red. FAIL the job — do
  // NOT open a pull request, and do not pretend the push succeeded as a deliverable. The work is
  // still on the branch (a retry resumes on it); the report carries each failing command's exit
  // code and captured output so the step's failure detail says exactly what broke.
  if (validationReport && !validationReport.passed) {
    return {
      // The work IS on the branch (the loop only runs for a pass that produced some, and the
      // harness pushes it) — a retry resumes on top of it. `error` is what marks the job failed;
      // reporting `pushed: false` here would misdescribe the branch state in the harness's own
      // result for no benefit.
      pushed,
      branch: pushBranch,
      summary,
      stats,
      error: validationFailureMessage(validationReport),
      failureCause: 'agent',
      ...(usage ? { usage } : {}),
      ...(callMetrics ? { callMetrics } : {}),
      ...verificationFields,
      ...effort,
    }
  }

  if (!pushed) {
    // A no-op: a failure for the implementer, a clean non-event for the fixers.
    if (job.noChangesIsError === false) {
      return {
        pushed: false,
        branch: pushBranch,
        summary,
        stats,
        ...(usage ? { usage } : {}),
        ...(callMetrics ? { callMetrics } : {}),
        ...ralphVerdict,
        ...verificationFields,
        ...effort,
      }
    }
    return {
      pushed: false,
      branch: pushBranch,
      summary,
      stats,
      error: noChangesReason('the agent produced no file changes', stats, stderrTail),
      failureCause: 'no-changes',
      ...(usage ? { usage } : {}),
      ...(callMetrics ? { callMetrics } : {}),
      ...verificationFields,
      ...effort,
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
      // The agent-authored briefing (title/body) wins field-wise over the dispatch-time text.
      pr: applyPrDescription(job.pr, prDescription),
      // A resumed run's PR is already open, so refresh it rather than lose the briefing to the
      // duplicate-PR 422 — only from a REAL briefing (see `refreshExisting` for why).
      ...(prDescription ? { refreshExisting: true } : {}),
      apiBase: job.githubApiBase,
      // The provider (set by the server from the configured backend) selects GitHub-PR vs
      // GitLab-MR authoritatively; the clone URL supplies the GitLab REST base + project path.
      // The harness's git auth is already host-neutral.
      cloneUrl: job.repo.cloneUrl,
      ...(job.repo.provider ? { provider: job.repo.provider } : {}),
      signal: opts.signal,
    })
    // `null` ⇒ the branch has nothing ahead of base, so there was no PR to open (a resumed
    // branch whose earlier PR already merged). Record it as a clean no-op rather than a push,
    // mirroring the no-changes outcome — the `runCodingAgent` guard normally catches this, so
    // this is the belt-and-suspenders path when the ahead-of-base check couldn't determine it.
    if (prUrl === null) {
      if (job.noChangesIsError === false) {
        return {
          pushed: false,
          branch: pushBranch,
          summary,
          stats,
          ...(usage ? { usage } : {}),
          ...(callMetrics ? { callMetrics } : {}),
          ...verificationFields,
          ...effort,
        }
      }
      return {
        pushed: false,
        branch: pushBranch,
        summary,
        stats,
        error: noChangesReason(
          'the work branch has no commits ahead of its base (nothing to open a PR for)',
          stats,
          stderrTail,
        ),
        failureCause: 'no-changes',
        ...(usage ? { usage } : {}),
        ...(callMetrics ? { callMetrics } : {}),
        ...verificationFields,
        ...effort,
      }
    }
    return {
      pushed: true,
      prUrl,
      branch: pushBranch,
      summary,
      stats,
      ...(usage ? { usage } : {}),
      ...(callMetrics ? { callMetrics } : {}),
      ...ralphVerdict,
      ...verificationFields,
      ...effort,
    }
  }
  return {
    pushed: true,
    branch: pushBranch,
    summary,
    stats,
    ...(usage ? { usage } : {}),
    ...(callMetrics ? { callMetrics } : {}),
    ...ralphVerdict,
    ...verificationFields,
    ...effort,
  }
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

    // DEPENDENCY PREPOPULATION, before this mode's agent turn. Resolving a conflict is a READING
    // task before it is a writing one — the agent has to understand what both sides do — so it
    // needs the dependency tree as much as any other kind. Placed AFTER the clean-merge branches
    // above so a conflict-free run (the common case) never pays for an install it has no agent to
    // hand the tree to; and the artifact exclusion inside matters here more than anywhere, because
    // this flow finishes its merge commit with a whole-tree `git add -A`.
    const workDir = await deriveWorkDir(dir, job.repo.serviceDirectory)
    const dependencyNote = await prepopulateDependencies({
      spec: job.dependencyInstall,
      installDir: workDir,
      repoDir: dir,
      // The agent resolves at the repo ROOT (git's conflict state is repo-wide), so a monorepo
      // service's install ran somewhere the agent is not standing and the note has to say where.
      agentDir: dir,
      logger,
      opts,
    })

    opts.onPhase?.('agent')
    logger.info('agent(conflict): resolving conflicts with agent', { conflicted })
    const diff = await conflictDiff(dir, conflicted, signal)
    const userPrompt = withDependencyNote(
      buildConflictPrompt(mergeBase, job.branch, conflicted, diff, job.userPrompt),
      dependencyNote,
    )

    const { summary, stats, stderrTail, usage, callMetrics, effortReport } =
      await runAgentInWorkspace(
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
          proxyPhasePath: job.proxyPhasePath,
          sessionToken: job.sessionToken,
          contextFiles: job.contextFiles,
          guardLimits: job.guardLimits,
          ...agentCapabilities(job),
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
      return mergeEffort(
        {
          pushed: false,
          branch: job.branch,
          summary,
          stats,
          error: unresolvedReason(unresolved, stats, stderrTail),
          failureCause: 'agent',
          ...(usage ? { usage } : {}),
          ...(callMetrics ? { callMetrics } : {}),
        },
        effortReport,
      )
    }
    // Complete the merge commit with the agent's resolution staged, then push.
    await commitAll(dir, `Merge ${mergeBase} into ${job.branch}`, signal)
    opts.onPhase?.('push')
    logger.info('agent(conflict): pushing resolved branch', { ...stats })
    await pushBranch(dir, job.branch, job.ghToken, signal)
    return mergeEffort(
      {
        pushed: true,
        branch: job.branch,
        summary,
        stats,
        ...(usage ? { usage } : {}),
        ...(callMetrics ? { callMetrics } : {}),
      },
      effortReport,
    )
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
