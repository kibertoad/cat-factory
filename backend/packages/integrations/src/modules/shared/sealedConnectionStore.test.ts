import { describe, expect, it } from 'vitest'
import type { SecretCipher } from '@cat-factory/kernel'
import { createOrgSecretCipher } from '@cat-factory/kernel'
import {
  createSealedConnectionStore,
  type SealedConnectionRepository,
  type SealedConnectionRow,
} from './sealedConnectionStore.js'

// The seam that let the document/task integrations cross the mothership persistence RPC: the row
// carries its credential bag SEALED, and this store is the one place it is opened or sealed.

type Kind = 'jira' | 'linear' | 'figma'

/** A cipher whose envelopes are inspectable, so a test can assert what actually got STORED. */
const cipher: SecretCipher = {
  encrypt: (plaintext) => Promise.resolve(`sealed(${plaintext})`),
  decrypt: (envelope) => {
    if (!envelope.startsWith('sealed(')) return Promise.reject(new Error('not an envelope'))
    return Promise.resolve(envelope.slice('sealed('.length, -1))
  },
}

function makeStore(seed: SealedConnectionRow<Kind>[] = []) {
  const rows = new Map(seed.map((row) => [row.source, row]))
  const calls = { get: 0, list: 0 }
  const repository: SealedConnectionRepository<Kind> = {
    getByWorkspace: (_ws, source) => {
      calls.get += 1
      return Promise.resolve(rows.get(source) ?? null)
    },
    listByWorkspace: () => {
      calls.list += 1
      return Promise.resolve([...rows.values()])
    },
    upsert: (record) => {
      rows.set(record.source, record)
      return Promise.resolve()
    },
    softDelete: (_ws, source) => {
      rows.delete(source)
      return Promise.resolve()
    },
  }
  const store = createSealedConnectionStore<Kind>({
    repository,
    orgSecrets: createOrgSecretCipher({ cipher }),
    secretSource: 'task_source_connection',
  })
  return { store, rows, calls }
}

function row(source: Kind, credentials: Record<string, string>): SealedConnectionRow<Kind> {
  return {
    workspaceId: 'ws_1',
    source,
    credentialsCipher: `sealed(${JSON.stringify(credentials)})`,
    label: `${source} label`,
    createdAt: 10,
    deletedAt: null,
  }
}

describe('createSealedConnectionStore', () => {
  it('seals on write and opens on read, leaving only ciphertext in the row', async () => {
    const { store, rows } = makeStore()
    await store.upsert({
      workspaceId: 'ws_1',
      source: 'jira',
      credentials: { apiToken: 't0ken' },
      label: 'Acme Jira',
      createdAt: 10,
      deletedAt: null,
    })
    // What the repository (and therefore the persistence RPC, and therefore the wire) sees.
    const stored = rows.get('jira')!
    expect(stored.credentialsCipher).toBe('sealed({"apiToken":"t0ken"})')
    expect(JSON.stringify(stored)).not.toContain('"apiToken":"t0ken"')

    const opened = await store.getByWorkspace('ws_1', 'jira')
    expect(opened?.credentials).toEqual({ apiToken: 't0ken' })
    expect(opened?.label).toBe('Acme Jira')
  })

  it('opens only the sources a caller named, in ONE stored-row read', async () => {
    // The property that keeps a corpus refresh from paying a round trip per shelf entry on a
    // mothership-mode node, where every open is one.
    const opened: string[] = []
    const { store, calls } = makeStore([
      row('jira', { a: '1' }),
      row('linear', { b: '2' }),
      row('figma', { c: '3' }),
    ])
    const result = await store.listBySources('ws_1', ['jira', 'figma'])
    opened.push(...result.map((connection) => connection.source))
    expect(opened.sort()).toEqual(['figma', 'jira'])
    expect(calls.list).toBe(1)
    expect(calls.get).toBe(0)
  })

  it('reads nothing at all for an empty source list', async () => {
    const { store, calls } = makeStore([row('jira', { a: '1' })])
    expect(await store.listBySources('ws_1', [])).toEqual([])
    expect(calls.list).toBe(0)
  })

  it('answers listSummaries without opening an envelope', async () => {
    // A settings panel renders labels. Opening a bag per connected source to draw one would make
    // a single unopenable row fail the whole list, which is the opposite of the remedy it needs.
    const { store } = makeStore([
      row('jira', { a: '1' }),
      { ...row('linear', {}), credentialsCipher: 'corrupt' },
    ])
    const summaries = await store.listSummaries('ws_1')
    expect(summaries.map((summary) => summary.source).sort()).toEqual(['jira', 'linear'])
    expect(summaries.every((summary) => !('credentials' in summary))).toBe(true)
  })

  it('THROWS on a bag it cannot open rather than answering an empty one', async () => {
    // The repositories this replaced returned `{}` on a failed decrypt, which is indistinguishable
    // from a connection saved with no credentials — so every caller re-derived the difference from
    // whatever the vendor said next.
    const { store } = makeStore([{ ...row('jira', {}), credentialsCipher: 'corrupt' }])
    await expect(store.getByWorkspace('ws_1', 'jira')).rejects.toThrow(/not an envelope/)
  })

  it('THROWS on a decrypted blob that is not a credential bag', async () => {
    const { store } = makeStore([{ ...row('jira', {}), credentialsCipher: 'sealed(["nope"])' }])
    await expect(store.getByWorkspace('ws_1', 'jira')).rejects.toThrow(/not a credential bag/)
  })

  it('passes softDelete straight through, so disconnecting needs no key', async () => {
    const { store, rows } = makeStore([{ ...row('jira', {}), credentialsCipher: 'corrupt' }])
    await store.softDelete('ws_1', 'jira', 99)
    expect(rows.has('jira')).toBe(false)
  })
})
