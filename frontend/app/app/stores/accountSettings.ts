import { defineStore } from 'pinia'
import { ref } from 'vue'
import type {
  AccountSettingsConfig,
  AccountSettingsView,
  UpdateAccountSettingsInput,
} from '~/types/accountSettings'
import { isModuleOffRefusal } from '~/composables/api/errors'

/**
 * Thrown by `saveConfigPatch` when the account's current config is not in hand. A panel disables
 * its save button on `isLoadedFor` first, so reaching this is a bug, not a state a user can make.
 */
export class AccountConfigNotLoadedError extends Error {
  constructor(accountId: string) {
    super(`The settings of account ${accountId} are not loaded, so there is no config to patch`)
    this.name = 'AccountConfigNotLoadedError'
  }
}

/**
 * Per-account deployment settings (admin only): the integration secrets — Slack app OAuth
 * credentials + the web-search upstream keys — sealed at rest in the DB. Secrets are
 * write-only: this store only ever holds the non-secret `summary` (which integrations are
 * configured), never the values. `available` mirrors the backend opt-in: the module-off 503 (no
 * ENCRYPTION_KEY) hides the panel. Loaded on demand from the account-settings panel.
 *
 * Several panels on the account's Team tab read and patch the one `view`, and the tab is not
 * remounted when the active account changes, so the view records which account it belongs to
 * (`isLoadedFor`), a load joins one already in flight for the same account, and a failed load
 * clears the view rather than leaving an earlier one in place.
 */
export const useAccountSettingsStore = defineStore('accountSettings', () => {
  const api = useApi()

  const view = ref<AccountSettingsView | null>(null)
  const viewAccountId = ref<string | null>(null)
  const loading = ref(false)
  const available = ref<boolean | null>(null)

  let inFlight: { accountId: string; promise: Promise<void> } | null = null

  /** Whether `view` is the CURRENT config of `accountId`, so a patch can carry the rest forward. */
  function isLoadedFor(accountId: string): boolean {
    return view.value !== null && viewAccountId.value === accountId
  }

  function load(accountId: string): Promise<void> {
    if (inFlight?.accountId === accountId) return inFlight.promise
    const promise = fetchView(accountId).finally(() => {
      if (inFlight?.promise !== promise) return
      inFlight = null
      loading.value = false
    })
    inFlight = { accountId, promise }
    loading.value = true
    return promise
  }

  async function fetchView(accountId: string) {
    // A load for another account started meanwhile, so this answer is no longer the one shown.
    const superseded = () => inFlight?.accountId !== accountId
    try {
      const next = await api.getAccountSettings(accountId)
      if (superseded()) return
      view.value = next
      viewAccountId.value = accountId
      available.value = true
    } catch (e) {
      if (superseded()) return
      view.value = null
      viewAccountId.value = null
      // The module-off 503 ⇒ the settings store isn't wired (no ENCRYPTION_KEY) ⇒ hide the panel.
      // Any other failure, an outage 503 included, is rethrown for the panel to state.
      if (isModuleOffRefusal(e)) {
        available.value = false
      } else {
        throw e
      }
    }
  }

  async function save(accountId: string, input: UpdateAccountSettingsInput) {
    view.value = await api.updateAccountSettings(accountId, input)
    viewAccountId.value = accountId
    available.value = true
    return view.value
  }

  /**
   * Writes the given config keys and keeps every other key as stored. The write itself REPLACES
   * the whole config, so the patch is merged onto the loaded view, and refused when the view is
   * not this account's: merging onto nothing would delete every sibling setting, and merging onto
   * another account's view would copy that account's settings over.
   */
  async function saveConfigPatch(
    accountId: string,
    patch: Partial<AccountSettingsConfig>,
    secrets?: UpdateAccountSettingsInput['secrets'],
  ) {
    const current = isLoadedFor(accountId) ? view.value : null
    if (!current) throw new AccountConfigNotLoadedError(accountId)
    return save(accountId, {
      config: { ...current.config, ...patch },
      ...(secrets ? { secrets } : {}),
    })
  }

  return { view, loading, available, isLoadedFor, load, save, saveConfigPatch }
})
