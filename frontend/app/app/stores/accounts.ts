import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { useUpsertList } from '~/composables/useUpsertList'
import type { AuditEventWire } from '@cat-factory/contracts'
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

    const { items: accounts, upsert: upsertAccount } = useUpsertList<Account>({ key: (a) => a.id })
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
      upsertAccount(account)
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
      upsertAccount(updated)
      return updated
    }

    /**
     * Set an account's monthly spend budget (the account tier). Admin-only on the
     * backend; `null` clears the limit. Patches the loaded account in place on success.
     */
    async function setSpendMonthlyLimit(id: string, limit: number | null) {
      const updated = await api.updateAccount(id, { spendMonthlyLimit: limit })
      upsertAccount(updated)
      return updated
    }

    // ---- members + invitations -------------------------------------------

    const { items: members, upsert: upsertMember } = useUpsertList<AccountMember>({
      key: (m) => m.userId,
    })
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
      upsertMember(updated)
      return updated
    }

    // ---- audit log + session revocation -----------------------------------
    // The audit log is a paginated, append-only feed, so it is kept OUT of `useUpsertList`: the
    // rows never change and never arrive out of band, and a keyed upsert list would quietly
    // reorder a page whose whole meaning is its order. Pages are appended in the order the server
    // served them, and `auditCursor` is opaque — it round-trips verbatim, never inspected.
    const auditEvents = ref<AuditEventWire[]>([])
    const auditCursor = ref<string | null>(null)
    const auditLoading = ref(false)

    /**
     * The audit feed has fallen behind something this session did. Set by the writers below and
     * cleared by whoever reloads; the audit viewer watches it.
     *
     * A flag rather than a reload, because reloading here is what conflated two outcomes: the
     * revocation and the feed refresh are separate calls that fail separately, and awaiting the
     * second inside the first reported a revocation that HAD succeeded as "could not sign the
     * member out" whenever the read failed after it. It also fired on surfaces with no audit
     * panel rendered (basic mode, and any account whose deployment wires no audit store), paying
     * for a read nothing was going to show and turning its 503 into an error about the write.
     *
     * The viewer owns the reload instead, which is where it belongs: it already distinguishes a
     * failed page from an empty one, and a refresh failure now renders in that slot rather than
     * as a false report about the revocation.
     */
    const auditStale = ref(false)

    /**
     * Load the newest page, replacing whatever was held. Used on open and on refresh, so a reader
     * is never shown a feed spliced from two different moments.
     */
    async function loadAuditEvents(accountId: string) {
      auditLoading.value = true
      // Cleared on ATTEMPT, not on success. A failed reload is reported by the viewer's own error
      // slot, and leaving the flag set would re-trigger the watch that just failed.
      auditStale.value = false
      try {
        const page = await api.listAuditEvents(accountId)
        auditEvents.value = page.events
        auditCursor.value = page.nextCursor
      } finally {
        auditLoading.value = false
      }
    }

    /** Append the next (older) page. A no-op at the end of the log. */
    async function loadMoreAuditEvents(accountId: string) {
      if (!auditCursor.value || auditLoading.value) return
      auditLoading.value = true
      try {
        const page = await api.listAuditEvents(accountId, { cursor: auditCursor.value })
        auditEvents.value = [...auditEvents.value, ...page.events]
        auditCursor.value = page.nextCursor
      } finally {
        auditLoading.value = false
      }
    }

    /**
     * End every session a member holds. Their membership and roles are untouched, so the roster
     * needs no patching — what changed is not visible in it, which is why the audit feed is
     * marked stale instead: the revocation's only lasting trace is the row it wrote.
     */
    async function revokeMemberSessions(accountId: string, userId: string) {
      await api.revokeMemberSessions(accountId, userId)
      auditStale.value = true
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
      auditEvents,
      auditCursor,
      auditLoading,
      auditStale,
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
      loadAuditEvents,
      loadMoreAuditEvents,
      revokeMemberSessions,
      loadEmailConnection,
      connectEmail,
      disconnectEmail,
    }
  },
  { persist: { pick: ['activeAccountId'] } },
)
