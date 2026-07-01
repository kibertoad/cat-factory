import { describe, expect, it } from 'vitest'
import { createLocalMachineTokenStore } from './machineTokenStore.js'

// Unit coverage for the local machine-token cache (docs/initiatives/mothership-mode.md): a
// single-row `node:sqlite` store for the mothership-minted token. All in-memory; no network.

const REC = {
  token: 'machine-abc',
  nodeId: 'node_1',
  userId: 'usr_1',
  accountIds: ['acc_1', 'acc_2'],
  exp: 1_800_000,
  createdAt: 1_000,
}

describe('LocalMachineTokenStore', () => {
  it('returns null before anything is cached', () => {
    const store = createLocalMachineTokenStore(':memory:')
    expect(store.read()).toBeNull()
    store.close()
  })

  it('round-trips a record, including the account_ids JSON array', () => {
    const store = createLocalMachineTokenStore(':memory:')
    store.write(REC)
    expect(store.read()).toEqual(REC)
    store.close()
  })

  it('is a singleton row: a second write REPLACES the first', () => {
    const store = createLocalMachineTokenStore(':memory:')
    store.write(REC)
    store.write({ ...REC, token: 'machine-xyz', accountIds: ['acc_3'] })
    const read = store.read()
    expect(read?.token).toBe('machine-xyz')
    expect(read?.accountIds).toEqual(['acc_3'])
    store.close()
  })

  it('clear() forgets the cached token', () => {
    const store = createLocalMachineTokenStore(':memory:')
    store.write(REC)
    store.clear()
    expect(store.read()).toBeNull()
    store.close()
  })
})
