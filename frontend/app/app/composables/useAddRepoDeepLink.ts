/**
 * Boot-time replay of an ADD-REPOSITORY deep link: `?addRepo=<owner>/<name>&provider=<id>&ws=<id>`.
 *
 * An integration that finds a repository the platform has no service for (sainte-beuve filing a
 * review, say) cannot create the service itself, because adding one is a person's choice of board,
 * role and layout. It sends the person here instead: the add-service window opens with the
 * repository already searched for, and selected once the connection lists it. `provider` is the
 * host the link means, so a link for a GitLab project is not silently matched against GitHub;
 * `ws` pins the board the same way a run link does. Integrations build it on `GET
 * /api/v1/deployment`; the format is published at
 * https://catfactory.ai/extend/public-api.html#sending-a-person-to-add-a-repository
 *
 * Signing in first keeps the query (`signInThenReload`), so a signed-out person lands here too.
 */
import { watch } from 'vue'
import type { GitHubAvailableRepo } from '~/types/domain'
import type { VcsProvider } from '~/types/vcs'
import { useUiStore } from '../stores/ui'
import { useWorkspaceStore } from '../stores/workspace'

/** What the add-service window is opened with: the repository to look for, and its host. */
export interface AddServicePrefill {
  repo: string
  provider: string | null
}

interface PendingAddRepoLink extends AddServicePrefill {
  workspaceId: string | null
}

const ADD_REPO_LINK_PARAMS = ['addRepo', 'provider', 'ws'] as const

/** `owner/name`, where a GitLab owner may itself be a nested group path. */
const REPO_PATH = /^[\w.-]+(?:\/[\w.-]+)+$/

/**
 * Read (and strip) an add-repository link from the current URL, or null when there is none or its
 * `addRepo` is not a repository path. Called before `workspace.init()` so `ws` can pin the board.
 */
export function captureAddRepoDeepLink(): PendingAddRepoLink | null {
  if (typeof window === 'undefined') return null
  const params = new URLSearchParams(window.location.search)
  const repo = params.get('addRepo')?.trim()
  if (!repo) return null
  const link = { repo, provider: params.get('provider'), workspaceId: params.get('ws') }
  for (const key of ADD_REPO_LINK_PARAMS) params.delete(key)
  const qs = params.toString()
  history.replaceState(null, '', window.location.pathname + (qs ? `?${qs}` : ''))
  return REPO_PATH.test(repo) ? link : null
}

/** The listed repository a prefill names, matched on its full path regardless of case. */
export function prefilledRepoMatch(
  prefill: AddServicePrefill,
  repos: readonly GitHubAvailableRepo[],
): GitHubAvailableRepo | undefined {
  const wanted = prefill.repo.toLowerCase()
  return repos.find((r) => `${r.owner}/${r.name}`.toLowerCase() === wanted)
}

/** Whether the link names a host other than the one this board is connected to. */
export function prefillProviderMismatch(
  prefill: AddServicePrefill | null,
  connected: VcsProvider | null,
): boolean {
  return prefill?.provider != null && connected !== null && prefill.provider !== connected
}

/** Capture an add-repository link and, once the board has hydrated, open the window with it. */
export function useAddRepoDeepLink(): void {
  const link = captureAddRepoDeepLink()
  if (!link) return

  const workspace = useWorkspaceStore()
  const ui = useUiStore()
  if (link.workspaceId) workspace.workspaceId = link.workspaceId

  // One-shot, for the same reasons `useRunDeepLink` spells out: a later refresh must not reopen a
  // window the person closed, and `immediate` runs the callback before `stop` is bound.
  let applied = false
  let stop: (() => void) | undefined
  stop = watch(
    () => workspace.ready,
    (ready) => {
      if (!ready || applied) return
      applied = true
      ui.openAddService({ repo: link.repo, provider: link.provider })
      stop?.()
    },
    { immediate: true },
  )
}
