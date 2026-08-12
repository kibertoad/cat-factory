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
  /** The stamp the backup tags are namespaced under. Injected so a test can pin it. */
  stamp: string
}

export type ProviderPurgePlan = {
  issues: IssuePurgePlan
  repos: readonly RepoPurgePlan[]
}

export async function planProviderPurge(
  clients: ProviderPurgeClients,
  input: ProviderPurgeInput,
): Promise<ProviderPurgePlan> {
  const issues = await planIssuePurge(clients.issues, {
    targets: input.targets,
    ledgerIssues: input.ledgerIssues,
    // The one place the suite's issue text is authored, so a purge cannot come to disagree with the
    // spec that files it. A second title added there is discovered here with no change.
    knownTitles: [offsetValidationIssue().title],
  })
  const repos: RepoPurgePlan[] = []
  for (const target of input.targets) {
    repos.push(await planRepoPurge(clients.content, target, input.stamp))
  }
  return { issues, repos }
}

export type ProviderPurgeReport = {
  issues: IssuePurgeReport
  repos: readonly RepoPurgeReport[]
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
  return { issues, repos }
}

export function providerPurgeSucceeded(report: ProviderPurgeReport): boolean {
  return issuePurgeSucceeded(report.issues) && repoPurgeSucceeded(report.repos)
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
  if (plan.issues.problems.length > 0) {
    lines.push('', '  Could not be read, so nothing was planned for it:')
    lines.push(...plan.issues.problems.map((problem) => `    ${problem}`))
  }
  return lines.join('\n')
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

  const recovery = report.repos.flatMap((repo) => recoveryLines(repo))
  if (recovery.length > 0) {
    lines.push('', '  HOW TO PUT A REPOSITORY BACK (nothing below was discarded):')
    lines.push(...recovery.map((line) => `  ${line}`))
  }
  return lines.join('\n')
}

function describeRepoOutcome(report: RepoPurgeReport): string {
  const outcome = report.outcome
  if (outcome.status === 'emptied') {
    return (
      `emptied by commit ${outcome.commitSha}` +
      (report.branchesDeleted.length > 0
        ? `, ${report.branchesDeleted.length} branch(es) deleted`
        : '') +
      (report.pullRequestsClosed.length > 0
        ? `, ${report.pullRequestsClosed.length} pull request(s) closed`
        : '')
    )
  }
  if (outcome.status === 'already-empty') return 'already empty, so nothing was written'
  if (outcome.status === 'no-commits') return 'has no commits, so there was nothing to empty'
  return `REFUSED: ${outcome.detail}`
}
