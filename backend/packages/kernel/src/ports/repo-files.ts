import type { CommitFilesInput, GitHubPullRequest, OpenPullRequestInput } from '../domain/types.js'
import type {
  CommitFilesResult,
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
   * pre-op to read a baseline artifact (e.g. `spec/spec.json`) into the agent's prompt,
   * and by a post-op to read the prior `version.json` for the staleness counter.
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
   * Commit a set of files onto a branch via the Git Data API (blob → tree → commit →
   * ref). Mirrors {@link GitHubClient.commitFiles}; the bound installation/repo are
   * implicit. An empty/no-op change is the caller's concern (render is deterministic,
   * so re-committing identical bytes is avoided by comparing the version hash).
   */
  commitFiles(input: CommitFilesInput): Promise<CommitFilesResult>
  /** Open a pull request (idempotent: returns the existing open PR if one matches head/base). */
  openPullRequest(input: OpenPullRequestInput): Promise<GitHubPullRequest>
}

/**
 * Build a {@link RepoFiles} bound to a workspace's GitHub installation + a repo. The
 * server implements this over the wired {@link GitHubClient}; the engine resolves the
 * installation id + repo ref for a run and hands the bound facade to pre/post-ops.
 */
export type ResolveRepoFiles = (installationId: number, ref: GitHubRepoRef) => RepoFiles
