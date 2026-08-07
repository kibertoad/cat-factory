import { describe, it, expect, vi } from 'vitest'
import { useAccountsStore } from '~/stores/accounts'

/**
 * The audit feed and the one write that produces a row in it.
 *
 * What these guard is the seam between them. Forcing a member's sessions to end leaves nothing
 * visible in the roster — the row IS the trace — so the feed has to be brought back into step.
 * Doing that by awaiting the read inside the write is what conflated the two: a revocation that
 * had already succeeded was reported to the admin as "could not sign the member out" whenever the
 * follow-up read failed, which on a deployment with no audit store wired is every time.
 */
describe('accounts store — audit feed and forced revocation', () => {
  it('reports a successful revocation as successful even when the audit read is broken', async () => {
    // The 204 landed. Nothing about a failing GET afterwards changes that, and telling an admin
    // otherwise invites them to do it again or to escalate a problem they do not have.
    const listAuditEvents = vi.fn(() => Promise.reject(new Error('audit store down')))
    const revokeMemberSessions = vi.fn(() => Promise.resolve())
    vi.stubGlobal('useApi', () => ({ listAuditEvents, revokeMemberSessions }))

    const store = useAccountsStore()
    await expect(store.revokeMemberSessions('acc_1', 'usr_2')).resolves.toBeUndefined()
    expect(revokeMemberSessions).toHaveBeenCalledWith('acc_1', 'usr_2')
  })

  it('does not read the audit log from the write path at all', async () => {
    // The write must not pay for a read nothing may be showing: the panel is absent in basic mode
    // and on any deployment that wires no audit store. Marking the feed stale leaves the reload to
    // the viewer, which is the only place that knows it is on screen and the only place that
    // renders a failed read AS a failed read.
    const listAuditEvents = vi.fn(() => Promise.resolve({ events: [], nextCursor: null }))
    vi.stubGlobal('useApi', () => ({
      listAuditEvents,
      revokeMemberSessions: () => Promise.resolve(),
    }))

    const store = useAccountsStore()
    await store.revokeMemberSessions('acc_1', 'usr_2')

    expect(listAuditEvents).not.toHaveBeenCalled()
    expect(store.auditStale).toBe(true)
  })

  it('propagates a failed revocation, which IS the caller’s business', async () => {
    vi.stubGlobal('useApi', () => ({
      listAuditEvents: () => Promise.resolve({ events: [], nextCursor: null }),
      revokeMemberSessions: () => Promise.reject(new Error('nope')),
    }))

    const store = useAccountsStore()
    store.auditStale = false

    await expect(store.revokeMemberSessions('acc_1', 'usr_2')).rejects.toThrow('nope')
    // Nothing was written, so the feed is not behind.
    expect(store.auditStale).toBe(false)
  })

  it('clears the stale flag on the reload ATTEMPT, not on its success', async () => {
    // Clearing on success would re-trigger the watch that just failed, on every failure, forever.
    // The failure is reported by the viewer's own error slot instead.
    vi.stubGlobal('useApi', () => ({
      listAuditEvents: () => Promise.reject(new Error('still down')),
      revokeMemberSessions: () => Promise.resolve(),
    }))

    const store = useAccountsStore()
    await store.revokeMemberSessions('acc_1', 'usr_2')
    expect(store.auditStale).toBe(true)

    await expect(store.loadAuditEvents('acc_1')).rejects.toThrow('still down')
    expect(store.auditStale).toBe(false)
    expect(store.auditLoading).toBe(false)
  })
})
