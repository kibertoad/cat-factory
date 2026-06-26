import type {
  BlockRepository,
  GitHubClient,
  GitHubPullRequestReview,
  PullRequestReviewProvider,
  PullRequestReviewSnapshot,
  ReviewThread,
} from '@cat-factory/kernel'
import type { ResolveRepoTarget } from '../agents/ContainerAgentExecutor.js'

export interface GitHubPullRequestReviewProviderDependencies {
  githubClient: GitHubClient
  /** Resolves the repo (installation + owner/name + base branch) a block's work targets. */
  resolveRepoTarget: ResolveRepoTarget
  /** Reads the block's recorded PR ref (head branch + number). */
  blockRepository: BlockRepository
}

const EMPTY: PullRequestReviewSnapshot = {
  headSha: null,
  requiredApprovingReviewCount: 1,
  assignedReviewers: [],
  approvals: 0,
  unresolvedThreads: [],
  comments: [],
}

/** A GitHub App's own comments/reviews show as `<app-slug>[bot]`; treat those as the bot. */
function isBotLogin(login: string): boolean {
  return login.endsWith('[bot]')
}

/** The standing review states that determine approval (a later COMMENTED/PENDING doesn't change it). */
const STANDING = new Set(['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'])

/**
 * Reduce a PR's review event log to the count of distinct reviewers whose LATEST standing review
 * is APPROVED. Mirrors GitHub's own rule: a `COMMENTED`/`PENDING` review after an approval does
 * not dismiss it (only an explicit CHANGES_REQUESTED / DISMISSED does). Approvers are NOT filtered
 * to the current requested-reviewer list — GitHub removes a reviewer from "requested" once they
 * approve, so filtering there would never count an approval.
 */
function countApprovals(reviews: GitHubPullRequestReview[]): number {
  const latestByAuthor = new Map<string, string>()
  for (const r of reviews) {
    if (!r.author || isBotLogin(r.author)) continue
    if (!STANDING.has(r.state)) continue
    latestByAuthor.set(r.author, r.state)
  }
  let approvals = 0
  for (const state of latestByAuthor.values()) if (state === 'APPROVED') approvals++
  return approvals
}

function toReviewThread(t: {
  id: string
  isResolved: boolean
  path: string | null
  line: number | null
  comments: { author: string; body: string; createdAt: number }[]
}): ReviewThread {
  const first = t.comments[0]
  const last = t.comments[t.comments.length - 1]
  const body = (last?.body ?? '').trim()
  return {
    threadId: t.id,
    author: first?.author ?? '',
    bodyExcerpt: body.length > 280 ? `${body.slice(0, 277)}…` : body,
    path: t.path,
    line: t.line,
    isBot: isBotLogin(last?.author ?? ''),
    latestCommentAt: t.comments.reduce((m, c) => Math.max(m, c.createdAt), 0),
  }
}

/**
 * Reads a block's PR human-review state from GitHub for the `human-review` gate: assigned
 * reviewers, the approval count (vs branch-protection's required count), the unresolved review
 * threads and the plain PR comments. Reads LIVE each poll (no projection table), mirroring
 * {@link GitHubCiStatusProvider}. Returns the empty snapshot (`headSha: null`) when there is no
 * resolvable PR branch + number yet (the engine treats that as "nothing to gate").
 */
export class GitHubPullRequestReviewProvider implements PullRequestReviewProvider {
  constructor(private readonly deps: GitHubPullRequestReviewProviderDependencies) {}

  async getReview(workspaceId: string, blockId: string): Promise<PullRequestReviewSnapshot> {
    const block = await this.deps.blockRepository.get(workspaceId, blockId)
    const branch = block?.pullRequest?.branch
    const number = block?.pullRequest?.number
    if (!branch || number == null) return EMPTY

    const target = await this.deps.resolveRepoTarget(workspaceId, blockId)
    if (!target) return EMPTY
    const ref = { owner: target.owner, repo: target.name }
    const gh = this.deps.githubClient

    // Head commit of the PR branch (the latest commit on the ref), for the GateProbe.
    const commits = await gh.listCommits(target.installationId, ref, { sha: branch })
    const headSha = commits.items[0]?.sha ?? null
    if (!headSha) return EMPTY

    const [requiredCount, assignedReviewers, reviews, threads, comments] = await Promise.all([
      gh.getRequiredApprovingReviewCount?.(target.installationId, ref, target.baseBranch) ??
        Promise.resolve(1),
      gh.listRequestedReviewers?.(target.installationId, ref, number) ?? Promise.resolve([]),
      gh.listPullRequestReviews?.(target.installationId, ref, number) ?? Promise.resolve([]),
      gh.listReviewThreads?.(target.installationId, ref, number) ?? Promise.resolve([]),
      gh.listIssueComments?.(target.installationId, ref, number) ?? Promise.resolve([]),
    ])

    return {
      headSha,
      requiredApprovingReviewCount: requiredCount,
      assignedReviewers,
      approvals: countApprovals(reviews),
      unresolvedThreads: threads.filter((t) => !t.isResolved).map(toReviewThread),
      comments: comments.map((c) => ({
        id: c.id,
        author: c.author,
        body: c.body,
        createdAt: c.createdAt,
        isBot: isBotLogin(c.author),
      })),
    }
  }

  async resolveThreads(
    workspaceId: string,
    blockId: string,
    threadIds: string[],
    reply: string,
  ): Promise<void> {
    if (threadIds.length === 0) return
    const target = await this.deps.resolveRepoTarget(workspaceId, blockId)
    if (!target) return
    const ref = { owner: target.owner, repo: target.name }
    const gh = this.deps.githubClient
    const wantsReply = reply.trim().length > 0
    for (const threadId of threadIds) {
      try {
        // RESOLVE first, then (only if a reply was requested) post the courtesy reply. Doing the
        // state-changing resolve before the cosmetic reply guarantees we never leave a bot reply
        // as a thread's latest comment while it is still unresolved — that combination would hide
        // the thread from the gate's outstanding set (bot-latest is treated as "addressed") yet
        // leave it open forever. An empty `reply` means "resolve only" (the probe's reconcile
        // retry passes ''), so a retry never double-posts the reply.
        await gh.resolveReviewThread?.(target.installationId, ref, threadId)
        if (wantsReply) await gh.replyToReviewThread?.(target.installationId, ref, threadId, reply)
      } catch {
        // best-effort per thread: a failure leaves it unresolved for the next probe to retry
      }
    }
  }
}
