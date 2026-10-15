import type { Ref } from 'vue'
import type { GitHubConnection, GitHubIssue, GitHubPullRequest, GitHubRepo } from '~/types/domain'
import type { GitHubStoreContext } from '~/stores/github/context'

/** What the projection load reads and writes. The store owns every ref. */
interface ProjectionLoadDeps {
  api: GitHubStoreContext['api']
  workspace: GitHubStoreContext['workspace']
  connection: Readonly<Ref<GitHubConnection | null>>
  repos: Ref<GitHubRepo[]>
  pulls: Ref<GitHubPullRequest[]>
  issues: Ref<GitHubIssue[]>
  loading: Ref<boolean>
}

interface ProjectionLoad {
  /** Read the projection again after a write, never sharing a read that started before it. */
  load: () => Promise<void>
  /** Read the projection again, sharing a read already in flight for the same connection. */
  refresh: () => Promise<void>
  /** Read the projection unless it is already loaded for the current connection. */
  ensureLoaded: () => Promise<void>
  /** Record a direct write to the projection, so a read that started before it cannot land. */
  markWritten: () => void
  /** Empty the lists and forget the load in one step. */
  clearProjection: () => void
}

interface InFlightRead {
  key: string
  promise: Promise<void>
}

/**
 * The repos / pull requests / issues projection read, and the record of what it is loaded for.
 *
 * One generation counter answers every question about whether a read may land. A read takes the
 * next number when it starts, and every direct write to the projection (`markWritten()`, which
 * `clearProjection()` calls too) takes one as well. A read lands only if its number is still the
 * latest and it was started for the connection that is current when it finishes, so a result that
 * a newer read, a write, a disconnect or a board switch overtook is dropped.
 *
 * The projection counts as loaded for a key made of the workspace and the connection. A connected
 * workspace with no linked repos is loaded: the empty list is its answer. A different workspace or
 * a new connection is a different key, so a reinstall is read again without anyone telling this
 * module that it happened.
 *
 * There are three doors. `ensureLoaded()` reads only when nothing is loaded, `refresh()` is a
 * deliberate re-read that still shares a read in flight, and `load()` is the re-read after a write,
 * which starts its own read so it never returns what the write replaced.
 */
export function createGitHubProjectionLoad(deps: ProjectionLoadDeps): ProjectionLoad {
  const { api, workspace, connection, repos, pulls, issues, loading } = deps

  let generation = 0
  let loadedKey: string | null = null
  let inFlight: InFlightRead | null = null

  /** What the projection is read for. Null while there is nothing to read: no board or no connection. */
  function currentKey(): string | null {
    const conn = connection.value
    if (!workspace.workspaceId || !conn) return null
    return `${workspace.workspaceId}:${conn.provider}:${conn.installationId}:${conn.connectedAt}`
  }

  async function read(mine: number, key: string, askedFor: string): Promise<void> {
    const [r, p, i] = await Promise.all([
      api.listGitHubRepos(askedFor),
      api.listGitHubPullRequests(askedFor),
      api.listGitHubIssues(askedFor),
    ])
    if (mine !== generation || key !== currentKey()) return
    repos.value = r
    pulls.value = p
    issues.value = i
    loadedKey = key
  }

  function start(key: string): Promise<void> {
    const mine = ++generation
    loading.value = true
    const entry: InFlightRead = {
      key,
      promise: read(mine, key, workspace.requireId()).finally(() => {
        // Only the read that still owns the slot settles the flag. One that a write, a clear or a
        // newer read replaced must not report the projection as settled.
        if (inFlight === entry) {
          inFlight = null
          loading.value = false
        }
      }),
    }
    inFlight = entry
    return entry.promise
  }

  function markWritten(): void {
    generation++
    inFlight = null
    loading.value = false
  }

  return {
    load: () => {
      const key = currentKey()
      return key ? start(key) : Promise.resolve()
    },
    refresh: () => {
      const key = currentKey()
      if (!key) return Promise.resolve()
      return inFlight?.key === key ? inFlight.promise : start(key)
    },
    ensureLoaded: () => {
      const key = currentKey()
      if (!key || loadedKey === key) return Promise.resolve()
      return inFlight?.key === key ? inFlight.promise : start(key)
    },
    markWritten,
    clearProjection: () => {
      markWritten()
      loadedKey = null
      repos.value = []
      pulls.value = []
      issues.value = []
    },
  }
}
