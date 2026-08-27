import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { makeDirClaimer } from './checkout-dir.js'
import type { AgentJob, AgentResult, PeerRepoSpec, ReferenceRepoSpec, RepoSpec } from './job.js'
import {
  branchAheadOfBase,
  branchHasCommitsSince,
  cloneExistingBranch,
  cloneRepo,
  commitTrackedEdits,
  createBranch,
  excludeFromGit,
  fetchReferenceBranches,
  headCommit,
  pushBranch,
  refreshFromBaseIfClean,
  remoteBranchExists,
} from './git.js'
import { salvageUntrackedWork, withSalvageOnlyNote } from './salvage.js'
import { openPullRequest } from './vcs-api.js'
import { applyPrDescription, PR_DESCRIPTION_FILE, readPrDescription } from './pr-description.js'
import { runAgentInWorkspace, withWorkspace } from './pi-workspace.js'
import type { RunOptions } from './runner.js'
import { log, type Logger } from './logger.js'
import { prepopulateDependencies, withDependencyNote } from './dependency-install.js'
import { agentCapabilities } from './agent-shared.js'
import {
  resolvePrTemplateNote,
  withPrTemplateNote,
  type PrTemplateResolution,
} from './pr-template.js'
import { noChangesReason } from './coding-agent.js'

// The multi-repo (service-connections) coding fan-out, extracted from `coding-agent.ts` as pure
// code motion so both files stay under their size budgets. It clones the primary repo and every
// connected peer as sibling checkouts under one workspace root, runs the agent once across all of
// them, and pushes + opens a pull request per repo the run actually changed. The single-repo
// skeleton it shares its git mechanics with (and the `noChangesReason` wording both report) stays
// in `coding-agent.ts`.

/** One repository participating in a multi-repo run: where to clone it + what to do after. */
interface RepoLeg {
  repo: RepoSpec
  /** Sibling directory name under the workspace root. */
  dirName: string
  /** Absolute checkout directory (filled during the clone phase). */
  dir: string
  /** Branch to clone (the repo's base). */
  cloneBranch: string
  /** Branch to create off the clone and push the work to (the shared `cat-factory/<block>`). */
  workBranch: string
  ghToken: string
  pr?: { title: string; body: string }
  /** The involved frames the dispatch attributed to this checkout, echoed onto its peer PR. */
  frameIds?: string[]
  primary: boolean
  /**
   * A READ-ONLY reference checkout (doc-writer's `referenceRepos`): cloned at its base branch for
   * the agent to read, but NEVER given a work branch, committed, or pushed. Skipped entirely in the
   * push phase, so it is structurally impossible for the run to write to it. Absent ⇒ a writable leg.
   */
  readOnly?: boolean
  /** The branch tip before the run — work iff the branch advances past it. */
  baseSha: string
  /** Whether an existing remote work branch was resumed (already carries prior work). */
  resumed: boolean
}

/**
 * Multi-repo coding (service-connections phase 3): clone the primary repo AND every connected
 * peer repo as SIBLING checkouts under one workspace root, run the agent ONCE with its cwd at
 * that root (so it makes the cross-service change coherently across all of them), then commit +
 * push each repo that actually changed and open one PR per dirty repo. The task's own-service PR
 * is reported as `prUrl`/`branch`; the peer PRs as `peerPullRequests`.
 *
 * Deliberately simpler than the single-repo {@link runCodingAgent} for the first cut: NO mid-run
 * checkpoint pushes (an evicted multi-repo run re-clones on retry — the deterministic work branch
 * still lets it resume any commits it managed to push at the end), NO warm-pool persistent
 * checkout (always ephemeral), and NO follow-up sentinel streaming. It reuses the SAME dir-scoped
 * git helpers, so the per-repo clone/commit/push/PR mechanics match the single-repo path exactly.
 */
export async function runMultiRepoCoding(
  job: AgentJob,
  opts: RunOptions = {},
): Promise<AgentResult> {
  const logger = (opts.log ?? log).child({ kind: 'multi-repo', jobId: job.jobId })
  const peers: PeerRepoSpec[] = job.peerRepos ?? []
  const references: ReferenceRepoSpec[] = job.referenceRepos ?? []
  const primaryWorkBranch = job.pushBranch ?? job.newBranch ?? job.branch

  // Assign the sibling directory per repo via the shared deterministic allocator
  // (`owner__name__digest`, matching the backend prompt's `siblingCheckoutDir`), shared with the
  // read-only explore fan-out.
  const claimDir = makeDirClaimer()
  const legs: RepoLeg[] = [
    {
      repo: job.repo,
      dirName: claimDir(job.repo),
      dir: '',
      cloneBranch: job.branch,
      workBranch: primaryWorkBranch,
      ghToken: job.ghToken,
      ...(job.pr ? { pr: job.pr } : {}),
      primary: true,
      baseSha: '',
      resumed: false,
    },
    ...peers.map((peer): RepoLeg => ({
      repo: peer.repo,
      dirName: claimDir(peer.repo),
      dir: '',
      cloneBranch: peer.repo.baseBranch,
      // Coding peers always carry `newBranch` (the backend sets the shared work branch);
      // fall back to the primary's for the type (read-only peers never reach this path).
      workBranch: peer.newBranch ?? primaryWorkBranch,
      ghToken: peer.ghToken ?? job.ghToken,
      ...(peer.pr ? { pr: peer.pr } : {}),
      ...(peer.frameIds?.length ? { frameIds: peer.frameIds } : {}),
      primary: false,
      baseSha: '',
      resumed: false,
    })),
    // Read-only reference repos (doc-writer): cloned as siblings the agent reads but never writes.
    // `workBranch` is set to the base only to satisfy the type — a read-only leg never branches or
    // pushes (guarded by `readOnly` in both the clone and push phases below).
    ...references.map((reference): RepoLeg => ({
      repo: reference.repo,
      dirName: claimDir(reference.repo),
      dir: '',
      cloneBranch: reference.repo.baseBranch,
      workBranch: reference.repo.baseBranch,
      ghToken: reference.ghToken ?? job.ghToken,
      primary: false,
      readOnly: true,
      baseSha: '',
      resumed: false,
    })),
  ]

  return withWorkspace('multi', async (root) => {
    // Clone (or resume) every sibling checkout under the workspace root and fetch the primary's
    // reference branches. Mutates each leg's `dir`/`resumed`/`baseSha` in place.
    await prepareMultiRepoCheckouts(root, legs, job, logger, opts)

    // DEPENDENCY PREPOPULATION for the PRIMARY leg, exactly as the read-only multi-repo fan-out
    // does it. The install is declared on ONE service frame (the primary repo's), so it runs in
    // that leg's checkout and is never fanned out across peers, whose own frames declare configs
    // this dispatch never resolved — running a `pnpm install` inside a Go checkout is not a
    // degraded outcome, it is a wrong one. A cross-repo implementer needs its dependencies for
    // the same reason a cross-repo investigator does; the note names the sibling directory
    // because the agent itself stands at the workspace root.
    //
    // At the leg's checkout ROOT, not a `serviceDirectory` subtree: this layout applies no
    // service-directory scoping anywhere (the agent runs at the root and the prompt explains the
    // sibling checkouts), and a root install is the one that resolves a monorepo workspace whole.
    const primaryLeg = legs.find((leg) => leg.primary)
    const dependencyNote = primaryLeg
      ? await prepopulateDependencies({
          spec: job.dependencyInstall,
          installDir: primaryLeg.dir,
          repoDir: primaryLeg.dir,
          agentDir: root,
          logger,
          opts,
        })
      : undefined

    // THE REPOS' OWN PR TEMPLATES: one per leg that will actually open a pull request, each named
    // by its sibling directory so the agent knows which checkout's briefing takes which shape —
    // the repos in a workspace need not share a template, or ship one at all. A read-only
    // reference leg is excluded by construction: it carries no `pr`, so nothing publishes for it.
    const prTemplate = await resolvePrTemplateNote({
      targets: legs
        .filter((leg) => leg.pr)
        .map((leg) => ({
          repoDir: leg.dir,
          repoLabel: leg.dirName,
          ...(leg.repo.provider ? { provider: leg.repo.provider } : {}),
        })),
      logger,
    })

    // Run the agent ONCE with its cwd at the workspace root, so it sees every sibling checkout
    // and can change them coherently. No monorepo/service-directory scoping — the multi-repo
    // note + the backend system-prompt section explain the layout.
    opts.onPhase?.('agent')
    logger.info('multi-repo: running agent', { repos: legs.map((l) => l.dirName) })
    const { summary, stats, stderrTail, usage, callMetrics, effortReport } =
      await runAgentInWorkspace(
        {
          dir: root,
          systemPrompt: job.systemPrompt,
          userPrompt: withDependencyNote(
            withPrTemplateNote(job.userPrompt, prTemplate.note),
            dependencyNote,
          ),
          model: job.model,
          harness: job.harness,
          subscriptionToken: job.subscriptionToken,
          subscriptionBaseUrl: job.subscriptionBaseUrl,
          ambientAuth: job.ambientAuth,
          proxyBaseUrl: job.proxyBaseUrl,
          proxyPhasePath: job.proxyPhasePath,
          sessionToken: job.sessionToken,
          guardLimits: job.guardLimits,
          ...(job.contextFiles ? { contextFiles: job.contextFiles } : {}),
          // Skills, tool servers and web research apply to a multi-repo run exactly as to a
          // single-repo one: they are properties of the AGENT KIND, not of the checkout layout.
          // Through the shared helper rather than re-spread here, which is what let this flow
          // drift from the single-repo one in the first place.
          ...agentCapabilities(job),
          multiRepo: true,
          // What the no-progress guard's working-tree bound decides on: see {@link probeDirsForLegs}.
          repoDirs: probeDirsForLegs(legs),
        },
        opts,
      )

    // Commit forgotten tracked edits, then push + open a PR for each repo the run actually changed.
    const { primaryPushed, primaryPrUrl, peerPullRequests } = await pushMultiRepoLegs(
      legs,
      job,
      logger,
      opts,
      root,
      prTemplate,
    )

    const anyWork = primaryPushed || peerPullRequests.length > 0
    if (!anyWork) {
      // Nothing changed in ANY repo. For the implementer this is a failure (as in the
      // single-repo path); a caller that tolerates a no-op (never the implementer today)
      // gets a clean non-event.
      if (job.noChangesIsError === false) {
        return {
          pushed: false,
          branch: primaryWorkBranch,
          summary,
          stats,
          ...(usage ? { usage } : {}),
          ...(callMetrics ? { callMetrics } : {}),
          ...(effortReport ? { effortReport } : {}),
        }
      }
      return {
        pushed: false,
        branch: primaryWorkBranch,
        summary,
        stats,
        error: noChangesReason(
          'the agent produced no file changes in any repository',
          stats,
          stderrTail,
        ),
        failureCause: 'no-changes',
        ...(usage ? { usage } : {}),
        ...(callMetrics ? { callMetrics } : {}),
        ...(effortReport ? { effortReport } : {}),
      }
    }
    logger.info('multi-repo: complete', {
      primaryPushed,
      primaryPrUrl: primaryPrUrl ?? null,
      peers: peerPullRequests.length,
    })
    return {
      pushed: primaryPushed,
      ...(primaryPrUrl ? { prUrl: primaryPrUrl } : {}),
      branch: primaryWorkBranch,
      ...(peerPullRequests.length ? { peerPullRequests } : {}),
      summary,
      stats,
      ...(usage ? { usage } : {}),
      ...(callMetrics ? { callMetrics } : {}),
      ...(effortReport ? { effortReport } : {}),
    }
  })
}

/**
 * Clone phase for {@link runMultiRepoCoding}: every repo into its sibling dir under the workspace
 * root. Resume an existing remote work branch (an evicted retry) rather than branching off base
 * again, then fetch the primary repo's reference branches. Mutates each leg's `dir`/`resumed`/
 * `baseSha` in place. Extracted so the multi-repo body stays small.
 */
async function prepareMultiRepoCheckouts(
  root: string,
  legs: RepoLeg[],
  job: AgentJob,
  logger: Logger,
  opts: RunOptions,
): Promise<void> {
  const { signal } = opts
  opts.onPhase?.('clone')
  for (const leg of legs) {
    const dir = join(root, leg.dirName)
    await mkdir(dir, { recursive: true })
    // A read-only reference leg: clone its base branch for the agent to read, and stop there —
    // no work branch, no resume, no base-refresh. It is skipped in the push phase, so it can
    // never be written to. (Kept in the loop so it lands in the same workspace root as siblings.)
    if (leg.readOnly) {
      logger.info('multi-repo: cloning read-only reference', {
        repo: leg.dirName,
        cloneBranch: leg.cloneBranch,
      })
      await cloneRepo({
        repo: { ...leg.repo, baseBranch: leg.cloneBranch },
        ghToken: leg.ghToken,
        dir,
        signal,
      })
      leg.dir = dir
      continue
    }
    leg.resumed = await remoteBranchExists(leg.repo.cloneUrl, leg.workBranch, leg.ghToken, signal)
    if (leg.resumed) {
      logger.info('multi-repo: resuming existing branch', {
        repo: leg.dirName,
        branch: leg.workBranch,
      })
      await cloneExistingBranch({
        cloneUrl: leg.repo.cloneUrl,
        branch: leg.workBranch,
        ghToken: leg.ghToken,
        dir,
        signal,
      })
    } else {
      logger.info('multi-repo: cloning', { repo: leg.dirName, cloneBranch: leg.cloneBranch })
      await cloneRepo({
        repo: { ...leg.repo, baseBranch: leg.cloneBranch },
        ghToken: leg.ghToken,
        dir,
        signal,
      })
      await createBranch(dir, leg.workBranch, signal)
    }
    leg.dir = dir
    // Exclude the agent-authored PR-description sentinel locally (as the single-repo path does)
    // so the agent's own `git add` can never stage the briefing into the PR it describes.
    await excludeFromGit(dir, PR_DESCRIPTION_FILE, signal)
    // The branch tip before the agent runs. Captured BEFORE the resume base refresh below so
    // that refresh's merge commit counts as advancement and is pushed (as in the single-repo
    // path). A fresh leg produced work iff its branch advances past this; a resumed leg already
    // carries prior work.
    leg.baseSha = await headCommit(dir, signal)
    // A resumed branch was cut from an OLDER base; merge the latest base in when the two merge
    // cleanly so the agent works against current base and the peer/own PRs stay current. On a
    // conflict this is a best-effort no-op (the merge gate handles a conflicting PR downstream),
    // mirroring the single-repo {@link runCodingAgent} resume refresh.
    if (leg.resumed) {
      const refreshed = await refreshFromBaseIfClean(
        dir,
        leg.cloneBranch,
        leg.ghToken,
        signal,
      ).catch(() => false)
      if (!refreshed) {
        logger.info('multi-repo: resume base refresh skipped (conflict or error)', {
          repo: leg.dirName,
          base: leg.cloneBranch,
        })
      }
    }
  }

  // Reference branches attach to the PRIMARY repo, so fetch them into the primary sibling
  // checkout's `origin/<b>` refs (best-effort per branch). The backend's reference-branches
  // prompt section names the primary repo's directory to run the read commands in.
  if (job.referenceBranches?.length) {
    const primaryLeg = legs.find((l) => l.primary)
    if (primaryLeg?.dir) {
      const fetched = await fetchReferenceBranches({
        dir: primaryLeg.dir,
        branches: job.referenceBranches,
        ghToken: primaryLeg.ghToken,
        signal,
        onSkip: (branch, reason) =>
          logger.warn('multi-repo: reference branch fetch skipped', { branch, reason }),
      })
      logger.info('multi-repo: fetched reference branches', {
        requested: job.referenceBranches.length,
        fetched: fetched.length,
      })
    }
  }
}

/**
 * The checkouts the no-progress guard's working-tree bound may judge this run on.
 *
 * A multi-repo run's cwd is the workspace ROOT, which is no git repository, so the guard's default
 * (probe the cwd) asks git a question with no answer: every probe throws, the driver re-arms
 * forever, and the bound is permanently unenforceable — strictly worse than the tool-name reading
 * it replaced. The writable legs are the repositories this run may change, so they are what it
 * has to show progress in.
 *
 * A READ-ONLY reference leg is excluded, and not merely as an optimisation: the run is forbidden
 * to write to it, so a change appearing there is not this run making progress and must never be
 * what saves it from the bound.
 */
export function probeDirsForLegs(legs: readonly { dir: string; readOnly?: boolean }[]): string[] {
  return legs.filter((leg) => !leg.readOnly).map((leg) => leg.dir)
}

/**
 * Push phase for {@link runMultiRepoCoding}: commit forgotten tracked edits, then push + open a PR
 * for each repo the run actually changed (a repo the agent left untouched is skipped — no branch,
 * no PR; a read-only reference leg is never committed or pushed). Extracted so the multi-repo body
 * stays small; returns the primary's push/PR state plus the peer PRs.
 */
async function pushMultiRepoLegs(
  legs: RepoLeg[],
  job: AgentJob,
  logger: Logger,
  opts: RunOptions,
  /** The workspace root the agent ran in — the fallback probe for the primary's briefing. */
  root: string,
  /** Which legs' briefings are filled templates — see the `titleFromHeading` read below. */
  prTemplate: PrTemplateResolution,
): Promise<{
  primaryPushed: boolean
  primaryPrUrl: string | undefined
  peerPullRequests: NonNullable<AgentResult['peerPullRequests']>
}> {
  const { signal } = opts
  opts.onPhase?.('push')
  let primaryPushed = false
  let primaryPrUrl: string | undefined
  const peerPullRequests: NonNullable<AgentResult['peerPullRequests']> = []
  for (const leg of legs) {
    // A read-only reference leg is never committed or pushed — the third layer of the read-only
    // guarantee (the spec carries no branch/PR, and the clone phase gave it no work branch).
    if (leg.readOnly) continue
    // Lift (and remove) the agent-authored PR description for THIS repo's PR before anything
    // else touches the checkout — each sibling checkout carries its own briefing for its own PR.
    // The agent's cwd here is the WORKSPACE ROOT rather than any one checkout, so an agent that
    // read the prompt loosely may well have written a single briefing there instead. Fall back
    // to it for the PRIMARY leg only: at the root there is nothing to say which repo it
    // describes, and the primary is the one the run is actually about.
    //
    // Per-leg `titleFromHeading`: only a leg whose OWN repo ships a template has repo-authored
    // headings in its sentinel, and the legs of a workspace need not agree about that — so this
    // is keyed on the leg, never on whether the run found any template at all.
    const readOptions = { titleFromHeading: !prTemplate.templated.has(leg.dir) }
    const agentPrDescription =
      (await readPrDescription(leg.dir, readOptions)) ??
      (leg.primary ? await readPrDescription(root, readOptions) : undefined)
    await commitTrackedEdits(leg.dir, job.commitMessage ?? leg.pr?.title ?? 'Agent changes', signal)
    // Whether the leg carried COMMITTED work before the salvage, read here and not after it.
    // Afterwards the salvage's own commit makes every leg it touched look advanced, and the two
    // are not the same claim: work the agent committed to this repo is a change it chose to make,
    // where a salvage-only leg is a branch built entirely out of files it left lying in that
    // checkout. Both are worth keeping; only one is worth presenting as a proposed change without
    // saying where it came from.
    const committedOwnWork = await branchHasCommitsSince(leg.dir, leg.baseSha, signal)
    // Recover this leg's new files, exactly as the single-repo settle path does and for the same
    // reason: `commitTrackedEdits` captures edits to files git ALREADY tracks, so a new file the
    // agent created and never added used to be listed, warned about and dropped. Runs BEFORE the
    // advanced/no-op judgement below, so a leg whose only work is those files is pushed rather
    // than read as untouched.
    const salvage = await salvageUntrackedWork({
      dir: leg.dir,
      occasion: { kind: 'settled' },
      logger: logger.child({ repo: leg.dirName }),
      ...(signal ? { signal } : {}),
    })
    const salvageOnly = !committedOwnWork && salvage.status === 'committed'
    const advanced = committedOwnWork || salvage.status === 'committed'
    let hasWork = advanced || leg.resumed
    if (leg.resumed && !advanced) {
      const ahead = await branchAheadOfBase(leg.dir, leg.repo.baseBranch, leg.ghToken, signal)
      if (ahead === false) hasWork = false
    }
    if (salvage.status === 'refused' || salvage.status === 'failed') {
      logger.warn('multi-repo: new files were left behind and are NOT in the push', {
        repo: leg.dirName,
        count: salvage.fileCount,
        reason: salvage.reason,
      })
    }
    if (!hasWork) {
      logger.info('multi-repo: no changes for repo', { repo: leg.dirName })
      continue
    }
    await pushBranch(leg.dir, leg.workBranch, leg.ghToken, signal)
    let prUrl: string | null = null
    if (leg.pr) {
      prUrl = await openPullRequest({
        owner: leg.repo.owner,
        name: leg.repo.name,
        ghToken: leg.ghToken,
        head: leg.workBranch,
        base: leg.repo.baseBranch,
        pr: withSalvageOnlyNote(applyPrDescription(leg.pr, agentPrDescription), salvageOnly),
        // See the single-repo call site: refresh a resumed leg's already-open PR, but only
        // when the text is the agent's own briefing rather than the dispatch-time fallback.
        ...(agentPrDescription ? { refreshExisting: true } : {}),
        apiBase: job.githubApiBase,
        cloneUrl: leg.repo.cloneUrl,
        ...(leg.repo.provider ? { provider: leg.repo.provider } : {}),
        signal,
      })
    }
    if (leg.primary) {
      primaryPushed = true
      if (prUrl) primaryPrUrl = prUrl
    } else if (prUrl) {
      peerPullRequests.push({
        repo: `${leg.repo.owner}/${leg.repo.name}`,
        ...(leg.frameIds?.length ? { frameIds: leg.frameIds } : {}),
        prUrl,
        branch: leg.workBranch,
      })
    }
  }
  return { primaryPushed, primaryPrUrl, peerPullRequests }
}
