import type { Ref } from 'vue'
import type {
  GitHubBranch,
  GitHubConnection,
  GitHubAvailableRepo,
  GitHubInstallationOption,
  GitHubIssue,
  GitHubPullRequest,
  GitHubRepo,
  RepoTreeEntry,
} from '~/types/domain'
import { useWorkspaceStore } from '~/stores/workspace'

/** Stable identity for a pull request in the `pulls` list: repo + PR number. */
export const pullKey = (repoGithubId: number, number: number) => `${repoGithubId}:${number}`

/**
 * Shared reactive state + injected dependencies the GitHub-store action factories close over.
 * Created once in the `github` store setup and threaded into {@link createGitHubConnectionActions}
 * and {@link createGitHubRepoActions} so the split operations stay behaviourally identical to the
 * original single-closure store — a size-only extraction mirroring `stores/board/` and
 * `stores/pipelines/`, not a new seam.
 */
export interface GitHubStoreContext {
  api: ReturnType<typeof useApi>
  workspace: ReturnType<typeof useWorkspaceStore>
  available: Ref<boolean | null>
  connection: Ref<GitHubConnection | null>
  installations: Ref<GitHubInstallationOption[]>
  loadingInstallations: Ref<boolean>
  repos: Ref<GitHubRepo[]>
  availableRepos: Ref<GitHubAvailableRepo[]>
  loadingAvailable: Ref<boolean>
  savingRepos: Ref<boolean>
  pulls: Ref<GitHubPullRequest[]>
  upsertPull: (pull: GitHubPullRequest) => void
  getPull: (key: string) => GitHubPullRequest | undefined
  issues: Ref<GitHubIssue[]>
  branches: Ref<Record<number, GitHubBranch[]>>
  repoFiles: Ref<Record<number, RepoTreeEntry[]>>
  syncing: Ref<boolean>
  /** Whether an App installation is bound (the store's `connected` computed). */
  connected: Readonly<Ref<boolean>>
  /** Reload the cached repos/PRs/issues projection (the store's `load`). */
  load: () => Promise<void>
}
