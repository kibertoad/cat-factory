import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type { Account, CloudProvider } from '~/types/domain'

/**
 * Account tenancy on the client: the accounts the signed-in user can switch
 * between (their personal account plus any orgs they belong to) and which one is
 * active. The active account scopes the board switcher and stamps new boards, so
 * a team can keep org boards separate from personal ones.
 *
 * Empty when auth is disabled (the backend returns no accounts in dev), in which
 * case the UI simply hides the account switcher and boards stay unscoped.
 */
export const useAccountsStore = defineStore(
  'accounts',
  () => {
    const api = useApi()

    const accounts = ref<Account[]>([])
    /** Active account id (persisted so a reload keeps the same context). */
    const activeAccountId = ref<string | null>(null)
    const ready = ref(false)

    const activeAccount = computed(
      () => accounts.value.find((a) => a.id === activeAccountId.value) ?? null,
    )
    /** Whether accounts exist (auth on); gates the switcher UI. */
    const enabled = computed(() => accounts.value.length > 0)

    /** Load the user's accounts and resolve the active one (persisted or first). */
    async function load() {
      accounts.value = await api.listAccounts()
      if (!activeAccountId.value || !accounts.value.some((a) => a.id === activeAccountId.value)) {
        activeAccountId.value = accounts.value[0]?.id ?? null
      }
      ready.value = true
    }

    /** Create a shared org account and make it active. */
    async function createOrg(name: string) {
      const account = await api.createAccount({ name })
      accounts.value.push(account)
      activeAccountId.value = account.id
      return account
    }

    /** Switch the active account (the caller re-scopes the board list). */
    function switchTo(id: string) {
      activeAccountId.value = id
    }

    /**
     * Set an account's default cloud provider (the provider new services inherit).
     * Owner-only on the backend; patches the loaded account in place on success.
     */
    async function setDefaultCloudProvider(id: string, provider: CloudProvider) {
      const updated = await api.updateAccount(id, { defaultCloudProvider: provider })
      const i = accounts.value.findIndex((a) => a.id === id)
      if (i >= 0) accounts.value[i] = updated
      return updated
    }

    return {
      accounts,
      activeAccountId,
      activeAccount,
      enabled,
      ready,
      load,
      createOrg,
      switchTo,
      setDefaultCloudProvider,
    }
  },
  { persist: { pick: ['activeAccountId'] } },
)
