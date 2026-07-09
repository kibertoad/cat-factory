import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { apiErrorEnvelope } from '~/composables/api/errors'
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
// start/retry (and each interaction with a live run) rides along with the cached password —
// sent as the `X-Personal-Password` header — and the user is only re-prompted once it
// expires (or is wrong).
//
// Every gated action (start / retry / confirm) re-validates the cache against an 8h EXPIRY
// BUFFER: a key with less than that runway left is withheld (treated as absent) so the
// server's 428 gate re-challenges EARLY and the modal refreshes the full window. This is
// what keeps a key from lapsing MID-PIPELINE — the run breaks with a retry only if the key
// was allowed to run down while the user wasn't looking, so we ask for re-entry while they
// still are (at the start/confirm/retry they just triggered), not later.
//
// Caching here is a DELIBERATE convenience choice, not a security weakness. The password
// layer exists to prevent ACCIDENTAL misuse (a credential can't be silently pooled); the
// real at-rest protection is the server's system encryption, which the cache doesn't touch.
// Re-prompting an engineer on every run would buy nobody anything (it wouldn't change the
// threat model), so we don't. The server never stores the password, the raw token is never
// returned to the client, and an external attacker still needs the system key — so the cache
// only ever helps on the very device the user is already signed in on. (See
// backend/docs/individual-subscription-usage.md §3.)

/** How long a typed password stays cached before the user is re-prompted (40h). */
const PASSWORD_TTL_MS = 40 * 60 * 60 * 1000
/**
 * Runway a cached password must still have for a gated action to ride it. Within this
 * window of expiry the key is withheld so the action re-challenges and refreshes the cache
 * EARLY — a buffer wide enough that a pipeline kicked off now won't outlive the key (8h).
 */
const PASSWORD_EXPIRY_BUFFER_MS = 8 * 60 * 60 * 1000
const CACHE_KEY = 'cf.personal-pw'

/** A credential prompt the UI must satisfy (set when the server replies 428). */
export interface PendingCredential {
  vendor: SubscriptionVendor
  reason: 'no_subscription' | 'password_required' | 'wrong_password' | 'subscription_expired'
  /** Re-run the gated action with the supplied password (start/retry). */
  retry: (password: string) => Promise<void>
  /** Abandon the prompt (Cancel / connect-instead): the gated action does NOT run. */
  cancel: () => void
}

/** Pull `{ vendor, reason }` out of a 428 credential_required error, else null. */
export function parseCredentialError(
  error: unknown,
): { vendor: SubscriptionVendor; reason: PendingCredential['reason'] } | null {
  const data = apiErrorEnvelope(error)
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
  /**
   * The cached password, or `undefined` when there is none to ride. `bufferMs` withholds a
   * still-valid key that is within that window of expiry (WITHOUT dropping it) so a gated
   * action re-challenges early; a truly-expired key is always removed. Default `0` = the
   * plain "is it still valid right now" read.
   */
  function getCachedPassword(bufferMs = 0): string | undefined {
    if (typeof localStorage === 'undefined') return undefined
    try {
      const raw = localStorage.getItem(CACHE_KEY)
      if (!raw) return undefined
      const { password, expiresAt } = JSON.parse(raw) as { password: string; expiresAt: number }
      if (Date.now() > expiresAt) {
        localStorage.removeItem(CACHE_KEY)
        return undefined
      }
      // Within the buffer the key is still valid — keep it, but withhold it so the action
      // re-challenges and refreshes the full window before it can lapse mid-pipeline.
      if (Date.now() + bufferMs > expiresAt) return undefined
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
   * Run a gated action (start/retry) that may require a personal credential. Supplies the
   * cached password on the first attempt; if the server replies 428, opens the credential
   * modal and AWAITS the user satisfying or cancelling it (transparently retrying via the
   * `pending.retry` closure). The caller's `action(password?)` performs the API call.
   *
   * Resolves `true` once the action actually ran (first try, or a successful retry), and
   * `false` when the user cancels the prompt — so a caller showing an optimistic spinner
   * can revert it instead of spinning forever. Still rejects for non-credential errors.
   */
  async function withCredential(action: (password?: string) => Promise<void>): Promise<boolean> {
    // First attempt may carry no password (non-individual runs) or the single cached one;
    // the server only consults it when the block needs it. A key within the expiry buffer
    // is withheld so an individual-usage action 428s and re-prompts EARLY (refreshing the
    // window) rather than riding a key that could lapse mid-pipeline.
    try {
      await action(getCachedPassword(PASSWORD_EXPIRY_BUFFER_MS))
      return true
    } catch (error) {
      const credential = parseCredentialError(error)
      if (!credential) throw error
      // A stale/wrong cached password — drop it so the modal is the source of truth.
      if (credential.reason === 'wrong_password') clearCachedPassword()
      return await new Promise<boolean>((resolve) => {
        const arm = (c: { vendor: SubscriptionVendor; reason: PendingCredential['reason'] }) => {
          pending.value = {
            ...c,
            retry: async (password: string) => {
              try {
                await action(password)
                setCachedPassword(password)
                pending.value = null
                resolve(true)
              } catch (retryError) {
                const again = parseCredentialError(retryError)
                if (again) {
                  // Still needs a credential (e.g. still-wrong password): keep the modal
                  // open with the fresh reason and let it surface its own toast.
                  if (again.reason === 'wrong_password') clearCachedPassword()
                  arm(again)
                  throw retryError
                }
                // A non-credential failure ends the flow: close the modal, revert the
                // caller's optimistic state, and surface the error to the modal's toast.
                pending.value = null
                resolve(false)
                throw retryError
              }
            },
            cancel: () => {
              pending.value = null
              resolve(false)
            },
          }
        }
        arm(credential)
      })
    }
  }

  function dismissPending() {
    // Settle the awaiting `withCredential` (the gated action never ran) before clearing.
    const current = pending.value
    pending.value = null
    current?.cancel()
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
