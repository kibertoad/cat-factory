import { getLocalSettingsContract, updateLocalSettingsContract } from '@cat-factory/contracts'
import type { UpdateLocalSettingsInput } from '~/types/localSettings'
import type { ApiContext } from './context'

/**
 * Local-mode operational settings (warm-container-pool sizing + per-repo checkout reuse) —
 * a per-deployment singleton. Wired only on the local-mode service; both calls 503 on the
 * Worker / stock Node facades (the store hides the panel then). No secrets, so the read view
 * is the plain config and the write replaces it wholesale.
 */
export function localSettingsApi({ send }: ApiContext) {
  return {
    getLocalSettings: () => send(getLocalSettingsContract, {}),

    updateLocalSettings: (body: UpdateLocalSettingsInput) =>
      send(updateLocalSettingsContract, { body }),
  }
}
