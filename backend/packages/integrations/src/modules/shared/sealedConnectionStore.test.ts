import { describe, expect, it, vi } from 'vitest'
import type { DelegatedSecretRef, SecretCipher, SecretDelegate } from '@cat-factory/kernel'
import { ORG_SECRET_KEY_ARITY, createOrgSecretCipher } from '@cat-factory/kernel'
import {
  ConnectionCredentialsUnreadableError,
  createSealedConnectionStore,
  type OpenedConnectionResult,
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

function makeStore(seed: SealedConnectionRow<Kind>[] = [], delegate?: SecretDelegate) {
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
    orgSecrets: createOrgSecretCipher({ cipher, ...(delegate ? { delegate } : {}) }),
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
    opened.push(...result.map((entry) => entry.source))
    expect(result.every((entry) => entry.status === 'opened')).toBe(true)
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
    const failure = await store.getByWorkspace('ws_1', 'jira').catch((error: unknown) => error)
    // A DomainError, so a controller answers 503 with a reason the SPA can translate rather than
    // the 500 a bare Error becomes; the cause is kept for the log, never for the client.
    expect(failure).toBeInstanceOf(ConnectionCredentialsUnreadableError)
    expect((failure as ConnectionCredentialsUnreadableError).code).toBe('unavailable')
    expect((failure as ConnectionCredentialsUnreadableError).details).toMatchObject({
      reason: 'connection_credentials_unreadable',
      source: 'jira',
    })
    expect((failure as { cause?: unknown }).cause).toMatchObject({ message: 'not an envelope' })
  })

  it('THROWS on a decrypted blob that is not a credential bag', async () => {
    const { store } = makeStore([{ ...row('jira', {}), credentialsCipher: 'sealed(["nope"])' }])
    await expect(store.getByWorkspace('ws_1', 'jira')).rejects.toBeInstanceOf(
      ConnectionCredentialsUnreadableError,
    )
  })

  it('confines an unopenable bag to its own source in a batch, opening the rest', async () => {
    // One rejected open used to reject the whole batch, so a single drifted row reported every
    // other source as unreadable too — a run's whole document corpus, a block's every reply
    // channel. They are independent vendors and independent facts.
    const { store } = makeStore([
      row('jira', { a: '1' }),
      { ...row('linear', {}), credentialsCipher: 'corrupt' },
      row('figma', { c: '3' }),
    ])

    const results = await store.listBySources('ws_1', ['jira', 'linear', 'figma'])
    const byStatus = (status: OpenedConnectionResult<Kind>['status']) =>
      results
        .filter((entry) => entry.status === status)
        .map((entry) => entry.source)
        .sort()

    expect(byStatus('opened')).toEqual(['figma', 'jira'])
    expect(byStatus('unreadable')).toEqual(['linear'])
  })

  it('names the ROW, not just the workspace, when a mothership opens the bag', async () => {
    // The delegated path's whole contract in one assertion. These rows are keyed
    // `(workspace, source)`, so `task_source_connection` declares `keyArity: 1` and a mothership
    // REFUSES (422) a request whose `key` disagrees. A local cipher ignores the ref entirely, so
    // every no-delegate test here passes with the key absent — which is exactly how a store that
    // sent none shipped green and failed every open on the only deployment shape that delegates.
    const unseal = vi.fn(async (_ref: DelegatedSecretRef) =>
      JSON.stringify({ apiToken: 'from-mothership' }),
    )
    const { store } = makeStore([row('jira', { apiToken: 'unused-local' })], {
      unseal,
      seal: async () => 'org(sealed)',
    })

    const opened = await store.getByWorkspace('ws_1', 'jira')

    expect(opened?.credentials).toEqual({ apiToken: 'from-mothership' })
    const ref = unseal.mock.calls[0]![0]
    expect(ref.source).toBe('task_source_connection')
    expect(ref.workspaceId).toBe('ws_1')
    expect(ref.key).toEqual(['jira'])
    // Derived from the declaration both halves read, never a literal restated beside it: a source
    // whose addressing changes fails this without anyone remembering to update a number.
    expect(ref.key).toHaveLength(ORG_SECRET_KEY_ARITY.task_source_connection)
  })

  it('passes softDelete straight through, so disconnecting needs no key', async () => {
    const { store, rows } = makeStore([{ ...row('jira', {}), credentialsCipher: 'corrupt' }])
    await store.softDelete('ws_1', 'jira', 99)
    expect(rows.has('jira')).toBe(false)
  })
})
