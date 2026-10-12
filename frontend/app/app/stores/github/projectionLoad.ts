import type { Ref } from 'vue'
import type { GitHubIssue, GitHubPullRequest, GitHubRepo } from '~/types/domain'
import { useSingleFlightProbe } from '~/composables/useSingleFlightProbe'
import type { GitHubStoreContext } from '~/stores/github/context'

/** What the projection load reads and writes. The store owns every ref. */
interface ProjectionLoadDeps {
  api: GitHubStoreContext['api']
  workspace: GitHubStoreContext['workspace']
  connected: Readonly<Ref<boolean>>
  repos: Ref<GitHubRepo[]>
  pulls: Ref<GitHubPullRequest[]>
  issues: Ref<GitHubIssue[]>
  loading: Ref<boolean>
}

/**
 * The repos / pull requests / issues projection read, and the record of whether it is loaded for
 * the current workspace.
 *
 * Whether the projection is loaded is tracked per workspace by the single-flight guard, never read
 * off `repos`: a connected workspace with no linked repos is loaded, and an empty list is its
 * answer. `load()` is the refresh door, so a reload after a write never rides a read that started
 * before it. `ensureLoaded()` shares whatever read is in flight. `clearProjection()` empties the
 * lists and forgets the load in one step, so no caller can do one without the other.
 */
export function createGitHubProjectionLoad(deps: ProjectionLoadDeps): {
  load: () => Promise<void>
  ensureLoaded: () => Promise<void>
  clearProjection: () => void
} {
  const { api, workspace, connected, repos, pulls, issues, loading } = deps

  // Reads can overlap: `load()` after a write starts a new one while an `ensureLoaded()` read is
  // still running. The reads do not finish in the order they started, so each one is numbered and
  // a result lands only if no newer read has already written. A read for a board the user has
  // left lands nowhere, and neither does a read that started before the projection was cleared in
  // the same workspace (a disconnect).
  let lastStartedRead = 0
  let oldestReadThatMayLand = 0

  async function runLoad() {
    const askedFor = workspace.requireId()
    const read = ++lastStartedRead
    loading.value = true
    try {
      const [r, p, i] = await Promise.all([
        api.listGitHubRepos(askedFor),
        api.listGitHubPullRequests(askedFor),
        api.listGitHubIssues(askedFor),
      ])
      if (read < oldestReadThatMayLand || workspace.workspaceId !== askedFor) return
      oldestReadThatMayLand = read
      repos.value = r
      pulls.value = p
      issues.value = i
    } finally {
      // Only the newest read clears the flag, so an older one finishing first does not report the
      // projection as settled while the newer read is still running.
      if (read === lastStartedRead) loading.value = false
    }
  }

  const guard = useSingleFlightProbe(runLoad, () => workspace.workspaceId)

  // Not connected means nothing to read. Both doors skip the guard then, because a run that reads
  // nothing would still record the projection as loaded, and a later connection would not load.
  return {
    load: () => (connected.value ? guard.probe({ afterWrite: true }) : Promise.resolve()),
    ensureLoaded: () => (connected.value ? guard.ensureProbed() : Promise.resolve()),
    clearProjection: () => {
      guard.invalidate()
      oldestReadThatMayLand = lastStartedRead + 1
      repos.value = []
      pulls.value = []
      issues.value = []
    },
  }
}
