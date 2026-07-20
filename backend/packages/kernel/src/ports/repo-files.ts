import type { CommitFilesInput, OpenedPullRequest, OpenPullRequestInput } from '../domain/types.js'
import type {
  CommitFilesResult,
  CreateReviewInput,
  CreateReviewResult,
  GitHubChangedFile,
  GitHubRepoRef,
  RepoContentEntry,
  RepoFileContent,
} from './github-client.js'

// ---------------------------------------------------------------------------
// RepoFiles port: a per-run, pre-bound facade over the GitHub Git Data + contents
// API for DETERMINISTIC, CHECKOUT-FREE repository operations run on the backend (an
// agent's pre/post-op) — reading a targeted, known subset of files and committing
// rendered files back, without cloning. It is the runtime-symmetric mechanism the
// blueprint/spec post-ops use to commit the `blueprints/`/`spec/` artifacts they
// render from a container agent's JSON: it talks only HTTP, so it works identically on
// the Cloudflare Worker (no filesystem) and Node.
//
// Unlike {@link GitHubClient} (every method keyed by installationId + repo ref), a
// RepoFiles is already bound to ONE workspace installation + ONE repo, so a post-op
// names only paths/branches. The server builds it from the wired GitHubClient via
// {@link ResolveRepoFiles}; tests supply a fake.
// ---------------------------------------------------------------------------

export interface RepoFiles {
  /**
   * Read a file's decoded UTF-8 content + blob sha on `gitRef` (a branch, tag or sha;
   * defaults to the repo's default branch), or null when the path is absent. Used by a
   * pre-op to read a baseline artifact (e.g. a `spec/modules/<m>/<g>.json` shard) into
   * the agent's prompt, and by a post-op to read a prior artifact for change detection.
   */
  getFile(path: string, gitRef?: string): Promise<RepoFileContent | null>
  /**
   * List a directory's entries on `gitRef`, or `[]` when the path is absent. Used by the
   * spec post-op to seed Gherkin feature files only when they don't already exist.
   */
  listDirectory(path: string, gitRef?: string): Promise<RepoContentEntry[]>
  /**
   * The head commit sha of `branch`, or null when the branch does not exist. Lets a
   * post-op decide create-vs-commit (the spec-writer runs before the coder, so its
   * branch may not exist yet) and resolve a base sha for {@link createBranch}.
   */
  headSha(branch: string): Promise<string | null>
  /** Create `branch` pointing at `fromSha` (e.g. the default branch's head). */
  createBranch(branch: string, fromSha: string): Promise<void>
  /**
   * Delete `branch`. Idempotent from the caller's view: a missing branch (already
   * deleted) is not an error. Used to reclaim a throwaway branch a run created (e.g.
   * the ephemeral-environment self-test's temp branch).
   */
  deleteBranch(branch: string): Promise<void>
  /**
   * Commit a set of files onto a branch via the Git Data API (blob → tree → commit →
   * ref), optionally DELETING paths (`input.deletions`) in the same commit — so a
   * deterministic render that drops a module/group also prunes its stale artifact file.
   * Mirrors {@link GitHubClient.commitFiles}; the bound installation/repo are implicit.
   * An empty/no-op change is the caller's concern (render is deterministic, so
   * re-committing identical bytes is avoided by comparing the version hash).
   */
  commitFiles(input: CommitFilesInput): Promise<CommitFilesResult>
  /**
   * Open a pull request (idempotent: returns the existing open PR if one matches head/base).
   * Returns the {@link OpenedPullRequest} — the projection plus the web `url` — so a post-op
   * can record a {@link PullRequestRef} (with a real link) on the block.
   */
  openPullRequest(input: OpenPullRequestInput): Promise<OpenedPullRequest>
  /**
   * The source (head) branch of a pull request by number, or null when the PR can't be read.
   * The PR-deep-review "fix" resolution reads this to point the Fixer's clone/push at the
   * reviewed PR's head branch (a `review` task carries only the PR number). Optional: a bound
   * client that can't read a PR head omits it, so the fix resolution reports the branch
   * unresolvable rather than pushing blind.
   */
  pullRequestHeadRef?(number: number): Promise<string | null>
  /**
   * The head commit sha of a pull request by number, or null when the PR can't be read. The
   * PR-deep-review captures this when the reviewer is dispatched (the review's "head at start")
   * and re-reads it at `post` time: a change means the PR branch moved since the review, so the
   * findings' frozen line numbers may have drifted and are folded into the summary rather than
   * anchored inline. Optional: a bound client that can't read a PR head sha omits it, so the
   * drift check is skipped (posting falls back to the per-line diff filtering).
   */
  pullRequestHeadSha?(number: number): Promise<string | null>
  /**
   * Publish a pull-request review's findings as individual inline comments + a summary comment
   * (the deep-review "post" resolution), returning a per-comment {@link CreateReviewResult} so a
   * partial post is reported rather than failing the whole set. Optional: a bound client that
   * can't post inline review comments omits it, so the "post" resolution reports it unsupported
   * rather than silently dropping the findings.
   */
  createReview?(number: number, input: CreateReviewInput): Promise<CreateReviewResult>
  /**
   * List the files a pull request changed (path, status, additions/deletions, and the per-file
   * `patch`). The `pr-reviewer` preOp reads this to hand the reviewer the diff + changed-file
   * list UP FRONT (as an injected `.cat-context/` file), so the container agent skips the early
   * `git fetch`/`git diff`/scratch-file reconstruction turns that dominate a long review's token
   * burn. Optional: a bound client that can't enumerate a PR's files omits it, so the preOp
   * passes through and the agent falls back to reconstructing the diff itself.
   */
  listChangedFiles?(number: number): Promise<GitHubChangedFile[]>
}

/**
 * Build a {@link RepoFiles} bound to a workspace's GitHub installation + a repo. The
 * server implements this over the wired {@link GitHubClient}; the engine resolves the
 * installation id + repo ref for a run and hands the bound facade to pre/post-ops.
 */
export type ResolveRepoFiles = (installationId: number, ref: GitHubRepoRef) => RepoFiles

/** The repo a block's run targets, resolved + bound for its pre/post-op hooks. */
export interface RunRepoContext {
  /** Checkout-free repo access bound to the run's installation + repo. */
  repo: RepoFiles
  /** The repo's default branch — the `base` clone target a repo-op resolves against. */
  baseBranch: string
}

/**
 * Resolve the {@link RunRepoContext} for a block's run: the run's installation + repo
 * (the same linkage the container executor's `resolveRepoTarget` walks) bound to a
 * {@link RepoFiles}, plus the repo's default branch. The engine calls this to run a
 * registered kind's pre/post-ops against the right repo. Returns null when GitHub isn't
 * connected (no installation / no repos / no client wired) so an unconfigured workspace —
 * or a test without GitHub — simply skips the ops instead of failing.
 */
export type ResolveRunRepoContext = (
  workspaceId: string,
  blockId: string,
) => Promise<RunRepoContext | null>
