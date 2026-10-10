import type {
  BlockRepository,
  GitHubClient,
  GitHubPullRequestComment,
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
  changesRequested: false,
  unresolvedThreads: [],
  comments: [],
  reviewSummaries: [],
}

/** A GitHub App's own comments/reviews show as `<app-slug>[bot]`; treat those as the bot. */
function isBotLogin(login: string): boolean {
  return login.endsWith('[bot]')
}

/** The standing review states that determine approval (a later COMMENTED/PENDING doesn't change it). */
const STANDING = new Set(['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'])

/** The reduction over a PR's review event log the gate cares about. */
interface ReviewReduction {
  /** Distinct reviewers whose LATEST standing review is APPROVED. */
  approvals: number
  /** Whether any reviewer's LATEST standing review is CHANGES_REQUESTED (blocks the merge). */
  changesRequested: boolean
  /** Every non-bot CHANGES_REQUESTED / COMMENTED review that carried a summary body. */
  summaries: PullRequestReviewSnapshot['reviewSummaries']
}

/**
 * Reduce a PR's review event log to the approval count, a standing-change-requested flag, and the
 * non-approving review summary bodies. Mirrors GitHub's own rule: a `COMMENTED`/`PENDING` review
 * after an approval does not dismiss it (only an explicit CHANGES_REQUESTED / DISMISSED does), and
 * a standing CHANGES_REQUESTED blocks the merge even when the required approvals are met by other
 * reviewers. The event log is sorted by `submittedAt` before the "latest per author" reduction so
 * the result never depends on the API's array order (submittedAt is 0 when unknown — those keep
 * their relative order via a stable sort). Approvers are NOT filtered to the current
 * requested-reviewer list — GitHub removes a reviewer from "requested" once they approve.
 */
function reduceReviews(reviews: GitHubPullRequestReview[]): ReviewReduction {
  const ordered = [...reviews].sort((a, b) => a.submittedAt - b.submittedAt)
  const latestStandingByAuthor = new Map<string, string>()
  const summaries: ReviewReduction['summaries'] = []
  let seq = 0
  for (const r of ordered) {
    if (!r.author || isBotLogin(r.author)) continue
    // A CHANGES_REQUESTED / COMMENTED review's summary body is reviewer feedback with no inline
    // thread — surface it as an outstanding-comment-shaped item (the cursor dedups it downstream).
    if ((r.state === 'CHANGES_REQUESTED' || r.state === 'COMMENTED') && r.body.trim().length > 0) {
      summaries.push({
        id: `review-${(seq += 1)}`,
        author: r.author,
        body: r.body,
        createdAt: r.submittedAt,
        isBot: false,
      })
    }
    if (STANDING.has(r.state)) latestStandingByAuthor.set(r.author, r.state)
  }
  let approvals = 0
  let changesRequested = false
  for (const state of latestStandingByAuthor.values()) {
    if (state === 'APPROVED') approvals++
    else if (state === 'CHANGES_REQUESTED') changesRequested = true
  }
  return { approvals, changesRequested, summaries }
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

  async getReview(
    workspaceId: string,
    blockId: string,
    cachedRequiredApprovingReviewCount?: number | null,
  ): Promise<PullRequestReviewSnapshot> {
    const block = await this.deps.blockRepository.get(workspaceId, blockId)
    const branch = block?.pullRequest?.branch
    const number = block?.pullRequest?.number
    if (!branch || number == null) return EMPTY

    const target = await this.deps.resolveRepoTarget(workspaceId, blockId)
    if (!target) return EMPTY
    const ref = { owner: target.owner, repo: target.name }
    const gh = this.deps.githubClient

    // Head commit of the PR branch (the latest commit on the ref), for the GateProbe. This gate
    // polls indefinitely, so use the exact single-ref lookup (one API call, correctly 404→null on
    // a deleted branch) rather than paginating the whole branch history just to read its tip.
    const headSha = await gh.branchHeadSha(target.installationId, ref, branch)
    if (!headSha) return EMPTY

    // The required-approval count is static repo config (branch protection), so the gate caches
    // it after the first probe and passes it back here — skip BOTH the base-branch lookup and the
    // protection read on every subsequent poll. On the first probe (no cache) read protection
    // against the PR's ACTUAL base branch (`pulls/{n}.base.ref`), not the repo default: a PR into
    // a stricter protected branch (e.g. a release branch requiring 2 approvals) must be gated
    // against its own rule. Fall back to the resolved repo default when the base ref is unreadable.
    const requiredCount =
      cachedRequiredApprovingReviewCount != null
        ? cachedRequiredApprovingReviewCount
        : await this.resolveRequiredApprovingReviewCount(target, ref, number)

    // The reviews (approval) + unresolved threads are needed on EVERY poll. The plain issue
    // comments and the assigned-reviewer list are consulted by the gate ONLY while the PR is
    // not yet approved — `classifyHumanReview` discards comments once approved, and the
    // assigned-reviewer list only feeds the "assign a reviewer" awaiting-approval card — so
    // skip those two reads once the PR is approved. Over an indefinite review wait that trims
    // the per-poll GitHub reads in the approved-with-open-threads window. (The dominant
    // not-yet-approved wait still needs all four; the GraphQL thread read has no etag, so it
    // can't be made conditional.) `approved` MUST mirror the gate's `isApproved` floor
    // (`max(1, requiredApprovingReviewCount)` — see review.logic.ts) so the provider never
    // skips a read the gate would have consulted.
    const [reviews, threads] = await Promise.all([
      gh.listPullRequestReviews?.(target.installationId, ref, number) ?? Promise.resolve([]),
      gh.listReviewThreads?.(target.installationId, ref, number) ?? Promise.resolve([]),
    ])
    const { approvals, changesRequested, summaries } = reduceReviews(reviews)
    // `approved` MUST mirror the gate's `isApproved` (review.logic.ts): required approvals met
    // AND no standing CHANGES_REQUESTED — so the provider never skips a read the gate would have
    // consulted (a change-requested PR is still awaiting the human, so its comments matter).
    const approved = approvals >= Math.max(1, requiredCount) && !changesRequested
    const [assignedReviewers, comments] = approved
      ? [[] as string[], [] as GitHubPullRequestComment[]]
      : await Promise.all([
          gh.listRequestedReviewers?.(target.installationId, ref, number) ?? Promise.resolve([]),
          gh.listIssueComments?.(target.installationId, ref, number) ?? Promise.resolve([]),
        ])

    return {
      headSha,
      requiredApprovingReviewCount: requiredCount,
      assignedReviewers,
      approvals,
      changesRequested,
      unresolvedThreads: threads.filter((t) => !t.isResolved).map(toReviewThread),
      comments: comments.map((c) => ({
        id: c.id,
        author: c.author,
        body: c.body,
        createdAt: c.createdAt,
        isBot: isBotLogin(c.author),
      })),
      reviewSummaries: summaries,
    }
  }

  /** Read branch-protection's required-approval count against the PR's actual base branch. */
  private async resolveRequiredApprovingReviewCount(
    target: { installationId: number; baseBranch: string },
    ref: { owner: string; repo: string },
    number: number,
  ): Promise<number> {
    const gh = this.deps.githubClient
    if (!gh.getRequiredApprovingReviewCount) return 1
    const baseRef =
      (await gh.getPullRequestBaseRef?.(target.installationId, ref, number)) ?? target.baseBranch
    // Pass the PR number too: a provider whose required count is PR-scoped (GitLab's per-MR
    // approval rule) reads it by number; GitHub ignores it and reads `baseRef`'s protection.
    return gh.getRequiredApprovingReviewCount(target.installationId, ref, baseRef, number)
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
    const failed: string[] = []
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
        // Best-effort per thread: keep going so a single bad thread doesn't strand the rest.
        failed.push(threadId)
      }
    }
    // Surface a partial failure to the caller. The gate's onHelperComplete RETAINS the handed
    // thread ids when this throws so the next probe's reconcile retries exactly those (a
    // swallowed failure here would let the gate clear its stash and re-dispatch a whole fixer
    // round for an already-fixed thread instead of the cheap resolve-only reconcile).
    if (failed.length > 0) {
      throw new Error(`Failed to resolve ${failed.length} review thread(s): ${failed.join(', ')}`)
    }
  }
}
