// The PROVIDER half of a reset: the issues a pass filed and the contents it scaffolded.
//
// `reset.ts` clears the board through the public API, which is everything an `admin` key can reach.
// The two things it has always had to state as leftovers are the two things only a provider
// credential can reclaim: an issue filed by the REPORTER (never the platform's to close) and the tree
// a scaffold run pushed. This composes them into one plan, one apply and one report so an operator
// reads a single answer rather than two half-answers.
//
// **It is behind `--purge-repos`, and that is a decision rather than caution.** The board reset needs
// no provider token and the README says so, because an operator clearing a half-built pass is
// routinely doing it BECAUSE the credentials it named have moved on. Making the provider half opt-in
// keeps that property exactly as it was, and keeps the destructive-looking half from arriving as a
// surprise on a command someone has run a dozen times.
//
// The two halves are composed but not interleaved: issues first, because closing one is cheap and
// reversible by a person, and a repository purge that fails should not leave the issues untouched as
// well.

import { describeThrown } from '@cat-factory/acceptance-kit'
import { offsetValidationIssue } from './instructions.ts'
import {
  applyIssuePurge,
  type IssuePurgePlan,
  type IssuePurgeReport,
  issuePurgeSucceeded,
  type LedgerIssue,
  planIssuePurge,
} from './issuePurge.ts'
import {
  applyRepoPurge,
  planRepoPurge,
  recoveryLines,
  type RepoContentApi,
  type RepoPurgePlan,
  type RepoPurgeReport,
  repoPurgeSucceeded,
  slug,
} from './repoPurge.ts'
import type { IssueApi, IssueTarget } from './vcsIssues.ts'

/** The two provider clients the purge drives. */
export type ProviderPurgeClients = {
  issues: IssueApi
  content: RepoContentApi
}

export type ProviderPurgeInput = {
  /** The two repositories this configuration points at. Nothing else is ever touched. */
  targets: readonly IssueTarget[]
  /** Issues recorded by the passes the board reset is removing. */
  ledgerIssues: readonly LedgerIssue[]
  /**
   * Issues recorded by passes whose files the reset KEEPS, which nothing here may close.
   *
   * Handed in rather than inferred, because discovery cannot tell them apart: a kept pass's issue
   * carries the same title and the same author as a removed one's, which is the fingerprint the
   * whole discovery test is built on. Without them the narrow half of a reset would settle the
   * scenario-04 gate of the very pass it went out of its way to leave resumable.
   */
  keptIssues: readonly LedgerIssue[]
  /**
   * Passes whose files this reset keeps, by run id.
   *
   * Named because the repositories are SHARED by every pass on a board while the state files are
   * per-pass: keeping a pass's ledger says it may be resumed, and emptying the repositories it ran
   * against says it may not. Both halves are true, so the preview states the consequence rather
   * than letting an operator read the retention as a promise the purge does not keep.
   */
  keptPasses: readonly string[]
  /** The stamp the backup tags are namespaced under. Injected so a test can pin it. */
  stamp: string
}

/** A repository whose plan could not be read, so nothing is planned for it. */
export type UnreadableRepo = { target: IssueTarget; problem: string }

export type ProviderPurgePlan = {
  issues: IssuePurgePlan
  repos: readonly RepoPurgePlan[]
  /**
   * Repositories a provider read refused, collected rather than thrown.
   *
   * The issue half has collected its own since it was written, and this half owed the same: a 403
   * from an org-restricted token, a 404 on a repository the credential cannot see, or an HTML body
   * from a proxy would otherwise escape a PREVIEW as a stack trace, printed above the board plan
   * that had not been rendered yet. A command whose whole first form is "read this before deciding"
   * has to survive one of its reads failing.
   */
  unreadableRepos: readonly UnreadableRepo[]
  /** Carried from the input, so the preview and the report state it identically. */
  keptPasses: readonly string[]
}

export async function planProviderPurge(
  clients: ProviderPurgeClients,
  input: ProviderPurgeInput,
): Promise<ProviderPurgePlan> {
  const issues = await planIssuePurge(clients.issues, {
    targets: input.targets,
    ledgerIssues: input.ledgerIssues,
    keptIssues: input.keptIssues,
    // The one place the suite's issue text is authored, so a purge cannot come to disagree with the
    // scenario that files it. A second title added there is discovered here with no change.
    knownTitles: [offsetValidationIssue().title],
  })
  const repos: RepoPurgePlan[] = []
  const unreadableRepos: UnreadableRepo[] = []
  for (const target of input.targets) {
    try {
      repos.push(await planRepoPurge(clients.content, target, input.stamp))
    } catch (error) {
      unreadableRepos.push({
        target,
        problem:
          `could not read ${slug(target)}, so nothing is planned for it and whatever it holds ` +
          `stays: ${describeThrown(error)}`,
      })
    }
  }
  return { issues, repos, unreadableRepos, keptPasses: input.keptPasses }
}

export type ProviderPurgeReport = {
  issues: IssuePurgeReport
  repos: readonly RepoPurgeReport[]
  /** Carried through from the plan: a repository nothing could be planned for was not purged. */
  unreadableRepos: readonly UnreadableRepo[]
  keptPasses: readonly string[]
}

export async function runProviderPurge(
  clients: ProviderPurgeClients,
  plan: ProviderPurgePlan,
): Promise<ProviderPurgeReport> {
  const issues = await applyIssuePurge(clients.issues, plan.issues)
  const repos: RepoPurgeReport[] = []
  for (const repoPlan of plan.repos) {
    repos.push(await applyRepoPurge(clients.content, repoPlan))
  }
  return { issues, repos, unreadableRepos: plan.unreadableRepos, keptPasses: plan.keptPasses }
}

export function providerPurgeSucceeded(report: ProviderPurgeReport): boolean {
  return (
    issuePurgeSucceeded(report.issues) &&
    repoPurgeSucceeded(report.repos) &&
    report.unreadableRepos.length === 0
  )
}

/** The plan, as the preview an operator grades before adding `--yes`. */
export function formatProviderPlan(plan: ProviderPurgePlan): string {
  const lines = ['', 'PROVIDER purge (--purge-repos):']

  if (plan.issues.close.length === 0) lines.push('  No issue to close.')
  else {
    lines.push(`  Issues to close (${plan.issues.close.length}):`)
    for (const issue of plan.issues.close) {
      lines.push(
        `    ${slug(issue.target)}#${issue.number} ${issue.url}` +
          (issue.found === 'named-by-pass'
            ? ` (named by pass ${issue.runId})`
            : ` (filed by this credential, titled '${issue.title}')`),
      )
    }
  }
  for (const skip of plan.issues.skipped) {
    lines.push(`    LEAVING ${slug(skip.target)}#${skip.number} '${skip.title}': ${skip.reason}`)
  }

  for (const repo of plan.repos) {
    lines.push(`  ${slug(repo.target)}:`)
    if (repo.head === null) {
      lines.push('    no commits at all, so there is nothing to empty')
      continue
    }
    if (repo.refusal !== null) {
      lines.push(`    REFUSES to empty it: ${repo.refusal}`)
      continue
    }
    if (repo.alreadyEmpty) {
      lines.push(`    already holds nothing but ${repo.keepPaths.join(', ') || 'an empty tree'}`)
      continue
    }
    lines.push(`    branch ${repo.head.branch} is at ${repo.head.commitSha}`)
    if (repo.removePaths.length > 0) {
      lines.push(
        `    remove from the tree (${repo.removePaths.length}): ${repo.removePaths.join(', ')}`,
      )
    }
    lines.push(`    keep: ${repo.keepPaths.join(', ') || 'NOTHING (no README found)'}`)
    if (repo.deleteBranches.length > 0) {
      lines.push(
        `    delete ${repo.deleteBranches.length} branch(es): ` +
          repo.deleteBranches.map((branch) => branch.name).join(', '),
      )
    }
    if (repo.closePullRequests.length > 0) {
      lines.push(
        `    close ${repo.closePullRequests.length} open pull request(s): ` +
          repo.closePullRequests.map((pull) => `#${pull.number}`).join(', '),
      )
    }
    lines.push(`    back up first, as tags: ${repo.backups.map((b) => b.tag).join(', ')}`)
  }

  lines.push(
    '',
    '  Nothing here discards anything. The emptying is an ordinary commit ON TOP of the current',
    '  tip, so the previous tree stays in history and one `git revert` restores it, and every ref',
    '  this touches is tagged at the sha it held first. The report prints the exact recovery',
    '  command for each repository.',
  )
  lines.push(...keptPassLines(plan.keptPasses, 'will no longer be'))
  const problems = [...plan.issues.problems, ...plan.unreadableRepos.map((repo) => repo.problem)]
  if (problems.length > 0) {
    lines.push('', '  Could not be read, so nothing was planned for it:')
    lines.push(...problems.map((problem) => `    ${problem}`))
  }
  return lines.join('\n')
}

/**
 * What emptying the shared repositories costs the passes this reset is KEEPING.
 *
 * Stated in both the preview and the report, and stated as a consequence rather than as a warning to
 * be dismissed: the board half of a narrow reset deliberately keeps those files (and this purge
 * deliberately leaves their issues open) so somebody can resume them, and there is exactly one set of
 * repositories on a board. Silence here would let the retention read as a promise the purge breaks.
 */
function keptPassLines(keptPasses: readonly string[], tense: string): readonly string[] {
  if (keptPasses.length === 0) return []
  return [
    '',
    `  ${keptPasses.length === 1 ? 'Pass' : 'Passes'} ${keptPasses.join(', ')} ` +
      `${keptPasses.length === 1 ? 'keeps its files' : 'keep their files'} and ` +
      `${keptPasses.length === 1 ? 'its issue' : 'their issues'}, but every pass on this board ` +
      `shares these repositories: emptied, ${keptPasses.length === 1 ? 'it' : 'they'} ${tense} ` +
      `resumable. Reset ${keptPasses.length === 1 ? 'it' : 'them'} too, or drop --purge-repos.`,
  ]
}

/** The outcome, per issue and per repository, with the recovery commands. */
export function formatProviderReport(report: ProviderPurgeReport): string {
  const lines = ['', 'PROVIDER purge:']

  for (const issue of report.issues.closed) {
    lines.push(`  closed ${slug(issue.target)}#${issue.number}`)
  }
  for (const issue of report.issues.alreadySettled) {
    lines.push(`  ${slug(issue.target)}#${issue.number} was already closed or gone`)
  }
  for (const failure of report.issues.failed) {
    lines.push(
      `  could NOT close ${slug(failure.issue.target)}#${failure.issue.number}: ${failure.detail}`,
    )
  }
  for (const skip of report.issues.skipped) {
    lines.push(`  left ${slug(skip.target)}#${skip.number} '${skip.title}': ${skip.reason}`)
  }
  lines.push(...report.issues.problems.map((problem) => `  ${problem}`))

  for (const repo of report.repos) {
    lines.push(`  ${slug(repo.target)}: ${describeRepoOutcome(repo)}`)
    lines.push(...repo.problems.map((problem) => `      ${problem}`))
  }
  lines.push(...report.unreadableRepos.map((repo) => `  ${repo.problem}`))

  const recovery = report.repos.flatMap((repo) => recoveryLines(repo))
  if (recovery.length > 0) {
    lines.push('', '  HOW TO PUT A REPOSITORY BACK (nothing below was discarded):')
    lines.push(...recovery.map((line) => `  ${line}`))
  }
  lines.push(...keptPassLines(report.keptPasses, 'are no longer'))
  return lines.join('\n')
}

/**
 * What became of one repository, INCLUDING what happened beside the tree.
 *
 * The tree, the pull requests and the branches are three writes with three preconditions, so the
 * tree's outcome is not the repository's: a delete guarded by its own backup tag goes ahead whether
 * or not the emptying commit did. A line reading "already empty, so nothing was written" over a
 * closed pull request and a deleted branch is the report telling an operator the opposite of what
 * this command just did, on the one surface they have for grading it.
 */
function describeRepoOutcome(report: RepoPurgeReport): string {
  const outcome = report.outcome
  const alsoDid = [
    ...(report.branchesDeleted.length > 0
      ? [`${report.branchesDeleted.length} branch(es) deleted`]
      : []),
    ...(report.pullRequestsClosed.length > 0
      ? [`${report.pullRequestsClosed.length} pull request(s) closed`]
      : []),
  ]
  const beside = alsoDid.length > 0 ? `; ${alsoDid.join(', ')}` : ''
  if (outcome.status === 'emptied') return `emptied by commit ${outcome.commitSha}${beside}`
  if (outcome.status === 'already-empty') {
    return `the tree was already empty, so no commit was written${beside}`
  }
  if (outcome.status === 'no-commits') return 'has no commits, so there was nothing to empty'
  return `REFUSED: ${outcome.detail}${beside}`
}
