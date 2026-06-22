import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type {
  PersonalSubscriptionStatus,
  StorePersonalSubscriptionInput,
  SubscriptionVendor,
} from '~/types/domain'

// The signed-in user's personal (individual-usage) subscriptions — Claude / GLM / Codex,
// which are licensed per individual and so stored per-user (not pooled) and unlocked with
// a personal PASSWORD. The token itself is double-encrypted server-side and never returned;
// this store only carries metadata + the renewal warning.
//
// To keep the password mostly transparent, it is cached CLIENT-SIDE in localStorage under a
// SINGLE key with a TTL: the backend gate applies one password to ALL of a run's
// individual-usage vendors, so there's no point keying the cache per vendor. A task
// start/retry rides along with the cached password, and the user is only re-prompted once it
// expires (or is wrong). Caching the password on this device does NOT weaken at-rest
// protection — the server never stores it, so the cache only helps on the very device the
// user is already signed in on; an external attacker would still need the system key.

/** How long a typed password stays cached before the user is re-prompted (8h). */
const PASSWORD_TTL_MS = 8 * 60 * 60 * 1000
const CACHE_KEY = 'cf.personal-pw'

/** A credential prompt the UI must satisfy (set when the server replies 428). */
export interface PendingCredential {
  vendor: SubscriptionVendor
  reason: 'no_subscription' | 'password_required' | 'wrong_password' | 'subscription_expired'
  /** Re-run the gated action with the supplied password (start/retry). */
  retry: (password: string) => Promise<void>
}

/** Pull `{ vendor, reason }` out of a 428 credential_required error, else null. */
export function parseCredentialError(
  error: unknown,
): { vendor: SubscriptionVendor; reason: PendingCredential['reason'] } | null {
  const data = (error as { data?: { error?: { code?: string; details?: unknown } } })?.data?.error
  if (data?.code !== 'credential_required') return null
  const details = data.details as {
    vendor?: SubscriptionVendor
    reason?: PendingCredential['reason']
  }
  if (!details?.vendor || !details?.reason) return null
  return { vendor: details.vendor, reason: details.reason }
}

export const usePersonalSubscriptionsStore = defineStore('personalSubscriptions', () => {
  const api = useApi()
  const subscriptions = ref<PersonalSubscriptionStatus[]>([])
  const loading = ref(false)
  /** When set, a credential modal should open to satisfy the pending prompt. */
  const pending = ref<PendingCredential | null>(null)

  async function load() {
    loading.value = true
    try {
      const { subscriptions: list } = await api.listPersonalSubscriptions()
      subscriptions.value = list
    } catch {
      // Auth disabled / not signed in / feature off → no personal subscriptions surface.
      subscriptions.value = []
    } finally {
      loading.value = false
    }
  }

  async function store(input: StorePersonalSubscriptionInput) {
    const status = await api.storePersonalSubscription(input)
    subscriptions.value = [...subscriptions.value.filter((s) => s.vendor !== status.vendor), status]
    // Cache the freshly-entered password so the next run rides along transparently.
    setCachedPassword(input.password)
    return status
  }

  async function remove(vendor: SubscriptionVendor) {
    await api.removePersonalSubscription(vendor)
    subscriptions.value = subscriptions.value.filter((s) => s.vendor !== vendor)
    // Don't clear the shared password cache — other connected vendors may still use it.
  }

  function has(vendor: SubscriptionVendor): boolean {
    return subscriptions.value.some((s) => s.vendor === vendor)
  }

  /** Subscriptions whose expiry is near or past — surfaced as a renewal nudge. */
  const renewals = computed(() => subscriptions.value.filter((s) => s.renewSoon))

  // --- client-side password cache (single localStorage key + TTL) ------------
  function getCachedPassword(): string | undefined {
    if (typeof localStorage === 'undefined') return undefined
    try {
      const raw = localStorage.getItem(CACHE_KEY)
      if (!raw) return undefined
      const { password, expiresAt } = JSON.parse(raw) as { password: string; expiresAt: number }
      if (Date.now() > expiresAt) {
        localStorage.removeItem(CACHE_KEY)
        return undefined
      }
      return password
    } catch {
      return undefined
    }
  }

  function setCachedPassword(password: string) {
    if (typeof localStorage === 'undefined') return
    try {
      localStorage.setItem(
        CACHE_KEY,
        JSON.stringify({ password, expiresAt: Date.now() + PASSWORD_TTL_MS }),
      )
    } catch {
      // best-effort
    }
  }

  function clearCachedPassword() {
    if (typeof localStorage === 'undefined') return
    try {
      localStorage.removeItem(CACHE_KEY)
    } catch {
      // best-effort
    }
  }

  /**
   * Run a gated action (start/retry) that may require a personal credential. Supplies
   * the cached password on the first attempt; if the server replies 428, opens the
   * credential modal so the user can connect/enter, then transparently retries via the
   * `pending.retry` closure. The caller's `action(password?)` performs the API call.
   */
  async function withCredential(action: (password?: string) => Promise<void>): Promise<void> {
    // First attempt may carry no password (non-individual runs) or the single cached one;
    // the server only consults it when the block needs it.
    try {
      await action(getCachedPassword())
    } catch (error) {
      const credential = parseCredentialError(error)
      if (!credential) throw error
      // A stale/wrong cached password — drop it so the modal is the source of truth.
      if (credential.reason === 'wrong_password') clearCachedPassword()
      pending.value = {
        ...credential,
        retry: async (password: string) => {
          await action(password)
          setCachedPassword(password)
          pending.value = null
        },
      }
    }
  }

  function dismissPending() {
    pending.value = null
  }

  return {
    subscriptions,
    loading,
    pending,
    renewals,
    load,
    store,
    remove,
    has,
    getCachedPassword,
    withCredential,
    dismissPending,
  }
})
