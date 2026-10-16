/**
 * Boot-time replay of a NEW API KEY deep link:
 * `?newApiKey=1&label=<label>&scope=<scope>&runsAsSelf=1&ws=<id>`.
 *
 * An integration that needs a person's OWN key (one bound to them, which is what lets a run use
 * their personal model subscription) cannot mint it for them: a bound key can only be minted by
 * its owner, signed in. It sends the person here instead, and the API tokens window opens with the
 * create form filled in. Nothing is minted until the person clicks create.
 *
 * Every parameter but `newApiKey` is optional. A scope this build does not know is dropped rather
 * than guessed at, and `runsAsSelf` only takes effect where there is a signed-in person to bind
 * (`ApiTokensPanel` withholds the choice otherwise). Signing in first keeps the query
 * (`postSignInUrl`). The format is published next to `?addRepo=` in the public API docs.
 */
import { PUBLIC_API_SCOPES } from '@cat-factory/contracts'
import { watch } from 'vue'
import type { PublicApiScope } from '~/types/publicApiKeys'
import { useUiStore } from '../stores/ui'
import { useWorkspaceStore } from '../stores/workspace'

/** What the API tokens window's create form is opened with. Absent fields keep their defaults. */
export interface NewApiKeyPrefill {
  label: string | null
  scope: PublicApiScope | null
  runsAsSelf: boolean
}

interface PendingNewApiKeyLink extends NewApiKeyPrefill {
  workspaceId: string | null
}

const NEW_API_KEY_LINK_PARAMS = ['newApiKey', 'label', 'scope', 'runsAsSelf', 'ws'] as const

/** The form's own label limit, so a prefill never starts out invalid. */
const LABEL_MAX_LENGTH = 120

function scopeOf(value: string | null): PublicApiScope | null {
  return (PUBLIC_API_SCOPES as readonly string[]).includes(value ?? '')
    ? (value as PublicApiScope)
    : null
}

/**
 * Read (and strip) a new-API-key link from the current URL, or null when there is none. Called
 * before `workspace.init()` so `ws` can pin the board.
 */
export function captureNewApiKeyDeepLink(): PendingNewApiKeyLink | null {
  if (typeof window === 'undefined') return null
  const params = new URLSearchParams(window.location.search)
  if (params.get('newApiKey') !== '1') return null
  const label = params.get('label')?.trim().slice(0, LABEL_MAX_LENGTH) || null
  const link: PendingNewApiKeyLink = {
    label,
    scope: scopeOf(params.get('scope')),
    runsAsSelf: params.get('runsAsSelf') === '1',
    workspaceId: params.get('ws'),
  }
  for (const key of NEW_API_KEY_LINK_PARAMS) params.delete(key)
  const qs = params.toString()
  history.replaceState(null, '', window.location.pathname + (qs ? `?${qs}` : ''))
  return link
}

/** Capture a new-API-key link and, once the board has hydrated, open the window with it. */
export function useNewApiKeyDeepLink(): void {
  const link = captureNewApiKeyDeepLink()
  if (!link) return

  const workspace = useWorkspaceStore()
  const ui = useUiStore()
  if (link.workspaceId) workspace.workspaceId = link.workspaceId

  // One-shot, as `useAddRepoDeepLink` is: a later refresh must not reopen a window the person
  // closed, and `immediate` runs the callback before `stop` is bound.
  let applied = false
  let stop: (() => void) | undefined
  stop = watch(
    () => workspace.ready,
    (ready) => {
      if (!ready || applied) return
      applied = true
      ui.openApiTokens({ label: link.label, scope: link.scope, runsAsSelf: link.runsAsSelf })
      stop?.()
    },
    { immediate: true },
  )
}
