import type { LocalSettings, UpdateLocalSettingsInput } from '~/types/localSettings'
import type { ApiContext } from './context'

/**
 * Local-mode operational settings (warm-container-pool sizing + per-repo checkout reuse) —
 * a per-deployment singleton. Wired only on the local-mode service; both calls 503 on the
 * Worker / stock Node facades (the store hides the panel then). No secrets, so the read view
 * is the plain config and the write replaces it wholesale.
 */
export function localSettingsApi({ http }: ApiContext) {
  return {
    getLocalSettings: () => http<LocalSettings>('/local-settings'),

    updateLocalSettings: (body: UpdateLocalSettingsInput) =>
      http<LocalSettings>('/local-settings', { method: 'PUT', body }),
  }
}
