import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type {
  Account,
  AccountInvitation,
  AccountMember,
  AccountRole,
  CloudProvider,
  EmailConnection,
} from '~/types/domain'

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

    /**
     * Set an account's monthly spend budget (the account tier). Admin-only on the
     * backend; `null` clears the limit. Patches the loaded account in place on success.
     */
    async function setSpendMonthlyLimit(id: string, limit: number | null) {
      const updated = await api.updateAccount(id, { spendMonthlyLimit: limit })
      const i = accounts.value.findIndex((a) => a.id === id)
      if (i >= 0) accounts.value[i] = updated
      return updated
    }

    // ---- members + invitations -------------------------------------------

    const members = ref<AccountMember[]>([])
    const invitations = ref<AccountInvitation[]>([])

    /** Load the active account's member roster + pending invitations. */
    async function loadRoster(accountId: string) {
      const [m, inv] = await Promise.all([
        api.listAccountMembers(accountId),
        api.listInvitations(accountId),
      ])
      members.value = m
      invitations.value = inv
    }

    /** Invite a teammate by email; returns the accept link (for manual sharing). */
    async function invite(accountId: string, email: string, roles: AccountRole[] = ['developer']) {
      const { invitation, acceptUrl } = await api.createInvitation(accountId, { email, roles })
      invitations.value = [invitation, ...invitations.value]
      return acceptUrl
    }

    async function revokeInvite(accountId: string, invitationId: string) {
      await api.revokeInvitation(accountId, invitationId)
      invitations.value = invitations.value.filter((i) => i.id !== invitationId)
    }

    /** Set a member's role set (admin-only); patches the loaded roster in place. */
    async function setMemberRoles(accountId: string, userId: string, roles: AccountRole[]) {
      const updated = await api.setMemberRoles(accountId, userId, roles)
      const i = members.value.findIndex((m) => m.userId === userId)
      if (i >= 0) members.value[i] = updated
      return updated
    }

    // ---- email sender connection -----------------------------------------

    const emailConnection = ref<EmailConnection | null>(null)
    const emailConfigured = ref(false)

    async function loadEmailConnection(accountId: string) {
      const res = await api.getEmailConnection(accountId)
      emailConnection.value = res.connection
      emailConfigured.value = res.configured
    }

    async function connectEmail(
      accountId: string,
      body: { provider: 'sendgrid' | 'resend'; apiKey: string; fromAddress: string },
    ) {
      emailConnection.value = await api.connectEmail(accountId, body)
    }

    async function disconnectEmail(accountId: string) {
      await api.disconnectEmail(accountId)
      emailConnection.value = null
    }

    return {
      accounts,
      activeAccountId,
      activeAccount,
      enabled,
      ready,
      members,
      invitations,
      emailConnection,
      emailConfigured,
      load,
      createOrg,
      switchTo,
      setDefaultCloudProvider,
      setSpendMonthlyLimit,
      loadRoster,
      invite,
      revokeInvite,
      setMemberRoles,
      loadEmailConnection,
      connectEmail,
      disconnectEmail,
    }
  },
  { persist: { pick: ['activeAccountId'] } },
)
