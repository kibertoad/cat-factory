// Emptying a target repository back to its README, RECOVERABLY.
//
// `reset` clears the board; this clears the other half it has always had to state as a leftover. A
// repository a previous pass scaffolded keeps every file, branch and open pull request, no `/api/v1`
// call can empty it, and `target-repos` cannot even READ whether one is empty, so a "clean" board
// plus a built-out repository is the state where a fresh pass scaffolds on top of a tree that is
// already there and nothing in the pass looks wrong.
//
// **The whole design constraint is that a mistake here must be undoable.** The two repositories are
// named in a `.env`, and a `.env` can name the wrong thing: the failure mode this guards against is
// an operator emptying a repository that mattered. So nothing here rewrites or discards history.
//
//   1. **The emptying is an ordinary commit ON TOP of the current tip**, whose tree holds only the
//      README. The previous tip is its PARENT, so every prior commit stays reachable from the branch
//      itself and `git revert` or `git reset --hard` restores the tree in one command. Updating the
//      branch is therefore a fast-forward, not a force: the API call cannot be the thing that loses
//      a commit, because it only ever moves the ref FORWARD. (The rejected alternative was a
//      parentless orphan commit, which reads as a genuinely fresh repository and makes the old tree
//      reachable from nothing, i.e. garbage-collectable. That is the one property worth trading
//      away here, and messy history is the price.)
//   2. **Every ref this touches is TAGGED first**, at the sha it held before. That is redundant for
//      the default branch (its own history already holds it) and load-bearing for the leftover
//      scaffold branches, which are deleted: a deleted branch's commits are reachable from nothing
//      unless something else names them.
//   3. **The recovery command is PRINTED, with the sha in it.** A purge that can be undone but does
//      not say how is only half the property, and the moment an operator needs it is the moment the
//      ledger naming the pass may already be gone.
//
// What it deliberately does NOT do: touch a repository other than the two the configuration names.
// There is no heuristic here for whether a repository "looks scaffolded", because no honest one
// exists (a scaffolded repo and a hand-built service look identical) and a wrong guess either
// refuses a legitimate reset or empties something on a hunch. Recoverability is the protection.

import { createHash } from 'node:crypto'
import { describeThrown } from '@cat-factory/acceptance-kit'

/** One repository, as both the provider's API and `GET /api/v1/repos` name it. */
export type PurgeTarget = { owner: string; repo: string }

/** The default branch and the commit it points at. */
export type RepoHead = {
  branch: string
  commitSha: string
}

export type RepoBranch = { name: string; commitSha: string }

export type RepoPullRequest = { number: number; title: string; headBranch: string }

/** What committing a README-only tree needs. Separated so the adapter owns the Git Data dance. */
export type KeepOnlyCommit = {
  branch: string
  parentSha: string
  /** Root paths to carry over, already decided by {@link planRepoPurge}. */
  keepPaths: readonly string[]
  message: string
}

/**
 * What this purge needs from a provider, narrowed to the calls it makes.
 *
 * A port rather than the REST client, for the reason `reset.ts` has one: the ORDER of the writes is
 * the safety property (tag before delete, commit before ref move), and a unit test asserting that
 * order is worth more than an integration test that can only say the end state looked right.
 */
export type RepoContentApi = {
  /** The default branch and tip, or null for a repository with no commits at all. */
  head(target: PurgeTarget): Promise<RepoHead | null>
  /** Root-level paths at that commit. */
  rootEntries(target: PurgeTarget, commitSha: string): Promise<readonly string[]>
  branches(target: PurgeTarget): Promise<readonly RepoBranch[]>
  openPullRequests(target: PurgeTarget): Promise<readonly RepoPullRequest[]>
  createTag(target: PurgeTarget, tag: string, commitSha: string): Promise<void>
  /** Commit a tree holding only `keepPaths`, parented on the tip. Answers the new commit sha. */
  commitKeepingOnly(target: PurgeTarget, commit: KeepOnlyCommit): Promise<string>
  /** Fast-forward a branch. Never a force: the new commit descends from the old tip. */
  updateBranch(target: PurgeTarget, branch: string, commitSha: string): Promise<void>
  closePullRequest(target: PurgeTarget, number: number): Promise<void>
  deleteBranch(target: PurgeTarget, branch: string): Promise<void>
}

/**
 * Whether a root entry is the README this purge keeps.
 *
 * Matched rather than assumed to be `README.md`, because a provider renders `README`, `README.rst`
 * and `readme.md` alike and the operator was told to create the repository "with a README and
 * nothing else". Keeping the wrong case would delete the one file the instruction named.
 */
export function isKeptPath(path: string): boolean {
  return /^readme(\.[^/]*)?$/i.test(path)
}

/**
 * The backup tag for one ref, at the sha it held before this purge.
 *
 * Two things a branch name can do that a tag name may not, and both end in the same place: the
 * provider answers 422, and a caller reading that as "it already exists" records a backup nothing
 * wrote. So the name is made VALID and made UNIQUE, rather than trusted.
 *
 * - **Valid**: git refuses a ref component holding a space, `~`, `^`, `:`, `?`, `*`, `[`, `\`, `..`
 *   or `@{`, one that starts with `.`, and one that ends in `.` or `.lock`. Everything outside
 *   `[A-Za-z0-9._-]` becomes `-`, doubled dots collapse, and the digest suffix means the name can
 *   never end in `.` or `.lock` whatever the branch was called.
 * - **Unique**: flattening alone maps `cat-factory/x` and `cat-factory-x` onto ONE tag, and the
 *   second of the two would then be "already backed up" at the first one's sha, which is the state
 *   that gets a branch deleted with nothing naming its commits. The digest is over the ORIGINAL
 *   name, so two distinct branches cannot share a tag.
 */
export function backupTagName(stamp: string, branch: string): string {
  const readable = branch
    .replace(/[^A-Za-z0-9._-]/g, '-')
    .replace(/\.{2,}/g, '.')
    .replace(/^\.+/, '')
  return `cf-acc-reset/${stamp}/${readable}-${digest(branch)}`
}

/** Eight hex characters of the branch name, which is what keeps two flattened names apart. */
function digest(branch: string): string {
  return createHash('sha1').update(branch).digest('hex').slice(0, 8)
}

export type PlannedBackup = { tag: string; branch: string; commitSha: string }

export type RepoPurgePlan = {
  target: PurgeTarget
  /** Null when the repository has no commits, which is nothing to empty rather than a failure. */
  head: RepoHead | null
  /** Root paths that would be removed by the emptying commit. */
  removePaths: readonly string[]
  /** Root paths carried over. Normally the one README. */
  keepPaths: readonly string[]
  /** Non-default branches that would be deleted, each backed up first. */
  deleteBranches: readonly RepoBranch[]
  /** Open pull requests that would be closed. */
  closePullRequests: readonly RepoPullRequest[]
  backups: readonly PlannedBackup[]
  /**
   * True when the tree already holds nothing but the README AND there is nothing else to do, so the
   * purge would write a commit that changes nothing.
   *
   * Stated rather than left to the apply, because an empty commit on a repository somebody is
   * looking at is noise that reads as "the reset did something odd", and the honest report for an
   * already-empty repository is that it was already empty.
   */
  alreadyEmpty: boolean
  /**
   * Why this repository will not be emptied at all, when the plan can already tell.
   *
   * One case reaches it: a tree with things to remove and NO README to keep. The commit that
   * expresses the emptying is a tree listing what stays, an empty one is a body the provider
   * rejects, and the failure would arrive after the backup tags were written. Refused where the
   * condition is KNOWN instead, so the preview names it and the apply writes nothing.
   */
  refusal: string | null
}

/**
 * What emptying one repository would do, from four reads.
 *
 * The reads are concurrent because none informs another; `rootEntries` is the one exception and it
 * needs the head first.
 */
export async function planRepoPurge(
  api: RepoContentApi,
  target: PurgeTarget,
  stamp: string,
): Promise<RepoPurgePlan> {
  const head = await api.head(target)
  if (head === null) {
    // No commits: no tree to empty, no branch to move, and a tag would have nothing to point at.
    // A repository in this state is what the operator was asked to create, minus the README.
    return {
      target,
      head: null,
      removePaths: [],
      keepPaths: [],
      deleteBranches: [],
      closePullRequests: [],
      backups: [],
      alreadyEmpty: true,
      refusal: null,
    }
  }

  const [entries, branches, pulls] = await Promise.all([
    api.rootEntries(target, head.commitSha),
    api.branches(target),
    api.openPullRequests(target),
  ])

  const keepPaths = entries.filter(isKeptPath)
  const removePaths = entries.filter((path) => !isKeptPath(path))
  const deleteBranches = branches.filter((branch) => branch.name !== head.branch)

  return {
    target,
    head,
    removePaths,
    keepPaths,
    deleteBranches,
    closePullRequests: pulls,
    // The default branch first, then each branch that is about to go. Every ref this purge writes
    // to or deletes gets one, so recovery never depends on which half of the plan failed.
    backups: [
      { tag: backupTagName(stamp, head.branch), branch: head.branch, commitSha: head.commitSha },
      ...deleteBranches.map((branch) => ({
        tag: backupTagName(stamp, branch.name),
        branch: branch.name,
        commitSha: branch.commitSha,
      })),
    ],
    alreadyEmpty: removePaths.length === 0 && deleteBranches.length === 0 && pulls.length === 0,
    refusal:
      removePaths.length > 0 && keepPaths.length === 0
        ? `${slug(target)} has no README at the root of ${head.branch}, and the emptying is ` +
          `expressed as a tree listing what STAYS: with nothing to keep there is no such tree to ` +
          `write. Branches and pull requests are left alone too, since the point of emptying them ` +
          `is a repository a fresh pass can scaffold into. Put a README on ${head.branch} (which ` +
          `is what the operator setup asks for) and run it again.`
        : null,
  }
}

/** The commit message the emptying lands under, naming what it was and how to undo it. */
export function purgeCommitMessage(plan: RepoPurgePlan): string {
  return (
    `chore: reset acceptance fixture repository\n\n` +
    `Emptied by the cat-factory acceptance reset so the next pass starts from a bare ` +
    `repository. Everything but the README was removed.\n\n` +
    `This commit is REVERTIBLE and discards nothing: its parent ` +
    `${plan.head?.commitSha ?? '(none)'} still holds the previous tree.\n` +
    `  git revert ${'<this commit>'}\n` +
    `  git reset --hard ${plan.head?.commitSha ?? '(none)'}\n`
  )
}

export type RepoPurgeOutcome =
  | { status: 'emptied'; commitSha: string }
  | { status: 'already-empty' }
  | { status: 'no-commits' }
  | { status: 'failed'; detail: string }

export type RepoPurgeReport = {
  target: PurgeTarget
  outcome: RepoPurgeOutcome
  /** The tip before anything was written, which is what recovery targets. */
  previousSha: string | null
  backupsCreated: readonly PlannedBackup[]
  branchesDeleted: readonly string[]
  pullRequestsClosed: readonly number[]
  /** Anything that refused, collected rather than thrown, one line each. */
  problems: readonly string[]
}

/**
 * Carry one repository's purge out, in the order that keeps it recoverable.
 *
 * Backups FIRST, and each one is the PRECONDITION of the write it protects rather than of the whole
 * repository: the default branch's tag gates the emptying commit, and a side branch's tag gates that
 * branch's delete and nothing else. Per-ref rather than all-or-nothing because the failure they
 * guard against is per-ref too (a protected ref, a name the provider will not tag), and aborting the
 * repository on the first one turns "leave that branch in place" into "leave everything in place",
 * which is a purge that reports failure without having tried the parts that would have worked.
 * Everything after a backup collects its failures and carries on, because a branch that will not
 * delete says nothing about the next one.
 */
export async function applyRepoPurge(
  api: RepoContentApi,
  plan: RepoPurgePlan,
): Promise<RepoPurgeReport> {
  const base = {
    target: plan.target,
    previousSha: plan.head?.commitSha ?? null,
    backupsCreated: [] as PlannedBackup[],
    branchesDeleted: [] as string[],
    pullRequestsClosed: [] as number[],
    problems: [] as string[],
  }
  if (plan.head === null) return { ...base, outcome: { status: 'no-commits' } }
  if (plan.refusal !== null) {
    return { ...base, outcome: { status: 'failed', detail: plan.refusal } }
  }
  if (plan.alreadyEmpty) return { ...base, outcome: { status: 'already-empty' } }

  const problems: string[] = []
  const backupsCreated: PlannedBackup[] = []
  for (const backup of plan.backups) {
    try {
      await api.createTag(plan.target, backup.tag, backup.commitSha)
      backupsCreated.push(backup)
    } catch (error) {
      problems.push(
        `could not create the backup tag '${backup.tag}' at ${backup.commitSha}, so nothing is ` +
          `written to '${backup.branch}': ${describeThrown(error)}`,
      )
    }
  }
  const headBackedUp = backupsCreated.some((backup) => backup.branch === plan.head?.branch)

  let outcome: RepoPurgeOutcome
  if (!headBackedUp) {
    // The emptying commit is revertible on its own, so this tag is redundant for RECOVERY. It is
    // kept as a precondition anyway because it is the cheapest possible probe of whether this
    // credential may write refs here at all, and finding that out by half-emptying a repository is
    // the more expensive way. The failure is already in `problems`, one line up.
    outcome = {
      status: 'failed',
      detail:
        `the backup tag for '${plan.head.branch}' did not land, so the tree was left exactly as ` +
        `it is (a purge that cannot be undone is not one this command performs)`,
    }
  } else if (plan.removePaths.length === 0) {
    // Nothing in the tree to remove, but branches or pull requests still made this repository
    // non-empty, so the tree is left exactly as it is rather than given a no-op commit.
    outcome = { status: 'already-empty' }
  } else {
    try {
      const commitSha = await api.commitKeepingOnly(plan.target, {
        branch: plan.head.branch,
        parentSha: plan.head.commitSha,
        keepPaths: plan.keepPaths,
        message: purgeCommitMessage(plan),
      })
      // Committed, THEN the ref moves. A commit nothing points at yet is inert; a ref moved to a
      // commit that failed to be created is the one ordering that could lose the branch.
      await api.updateBranch(plan.target, plan.head.branch, commitSha)
      outcome = { status: 'emptied', commitSha }
    } catch (error) {
      outcome = { status: 'failed', detail: describeThrown(error) }
    }
  }

  // Pull requests before their branches: closing one is recoverable (it can be reopened) and
  // deleting the head branch of an OPEN pull request is the thing a provider reacts to by closing
  // it anyway, with no record of which half did it.
  const pullRequestsClosed: number[] = []
  for (const pull of plan.closePullRequests) {
    try {
      await api.closePullRequest(plan.target, pull.number)
      pullRequestsClosed.push(pull.number)
    } catch (error) {
      problems.push(`could not close pull request #${pull.number}: ${describeThrown(error)}`)
    }
  }

  const branchesDeleted: string[] = []
  for (const branch of plan.deleteBranches) {
    // Only a branch whose backup tag actually landed: the tag is what makes the delete undoable,
    // and deleting one whose backup is missing is the single destructive act available here.
    if (!backupsCreated.some((backup) => backup.branch === branch.name)) {
      problems.push(
        `left branch '${branch.name}' in place: its backup tag was not created, and deleting it ` +
          `would be unrecoverable`,
      )
      continue
    }
    try {
      await api.deleteBranch(plan.target, branch.name)
      branchesDeleted.push(branch.name)
    } catch (error) {
      problems.push(`could not delete branch '${branch.name}': ${describeThrown(error)}`)
    }
  }

  return {
    ...base,
    outcome,
    backupsCreated,
    branchesDeleted,
    pullRequestsClosed,
    problems,
  }
}

/**
 * How to put one repository back, rendered from what the purge actually wrote.
 *
 * Two commands rather than one, because they undo different amounts: reverting restores the tree and
 * keeps the purge in history, resetting removes the purge as well. Both are offered because which one
 * is wanted depends on whether the repository turned out to matter.
 */
export function recoveryLines(report: RepoPurgeReport): readonly string[] {
  if (report.outcome.status !== 'emptied') {
    if (report.backupsCreated.length === 0) return []
    // "The tree was not emptied" is not "nothing happened": each branch delete is guarded by its own
    // backup, so some can have gone ahead while the commit refused. Saying otherwise would send an
    // operator away from a recovery they need.
    const deleted = report.branchesDeleted.length
    return [
      `${slug(report.target)}: the tree was NOT emptied` +
        (deleted > 0
          ? `, but ${deleted} branch(es) were deleted: ${report.branchesDeleted.join(', ')}. `
          : `. `) +
        `The backup tags below name every ref at the sha it held.`,
      ...report.backupsCreated.map((backup) => `    ${backup.tag} -> ${backup.commitSha}`),
    ]
  }
  const lines = [
    `${slug(report.target)}: emptied by commit ${report.outcome.commitSha}, on top of ` +
      `${report.previousSha ?? '(none)'}. Nothing was discarded. To put it back:`,
    `    git revert ${report.outcome.commitSha}        # keeps the purge in history`,
    `    git reset --hard ${report.previousSha ?? '(none)'}   # removes it too`,
  ]
  if (report.backupsCreated.length > 0) {
    lines.push(`  Every ref this touched is also tagged at the sha it held before:`)
    lines.push(...report.backupsCreated.map((backup) => `    ${backup.tag} -> ${backup.commitSha}`))
  }
  if (report.branchesDeleted.length > 0) {
    lines.push(
      `  Deleted ${report.branchesDeleted.length} branch(es), each recoverable from its tag: ` +
        `${report.branchesDeleted.join(', ')}`,
    )
  }
  return lines
}

export function slug(target: PurgeTarget): string {
  return `${target.owner}/${target.repo}`
}

/** Whether every repository purge did what it planned. */
export function repoPurgeSucceeded(reports: readonly RepoPurgeReport[]): boolean {
  return reports.every(
    (report) => report.outcome.status !== 'failed' && report.problems.length === 0,
  )
}
