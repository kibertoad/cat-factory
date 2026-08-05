import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import {
  type LocalVcsCredentialStore,
  createLocalVcsCredentialStore,
} from './vcsCredentialStore.js'

const KEY = Buffer.alloc(32, 7).toString('base64')
const OTHER_KEY = Buffer.alloc(32, 9).toString('base64')

/** Run `body` against a store backed by a real file (what the two sealing cases need to see). */
function withTempStore(body: (path: string, store: LocalVcsCredentialStore) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'cf-vcs-cred-'))
  const path = join(dir, 'vcs-credential.sqlite')
  try {
    body(path, createLocalVcsCredentialStore(path, KEY))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('createLocalVcsCredentialStore', () => {
  it('round-trips the sealed token', () => {
    const store = createLocalVcsCredentialStore(':memory:', KEY, () => 1000)
    expect(store.read()).toBeNull()
    store.write({ provider: 'github', token: 'ghp_secret', login: 'octocat' })
    expect(store.read()).toEqual({
      provider: 'github',
      token: 'ghp_secret',
      login: 'octocat',
      updatedAt: 1000,
    })
  })

  it('holds ONE credential — a write replaces the previous one', () => {
    const store = createLocalVcsCredentialStore(':memory:', KEY)
    store.write({ provider: 'github', token: 'ghp_old', login: null })
    store.write({ provider: 'gitlab', token: 'glpat_new', login: 'dev' })
    expect(store.read()).toMatchObject({ provider: 'gitlab', token: 'glpat_new' })
  })

  it('seals the token — the row does not carry it in the clear', () => {
    withTempStore((path, store) => {
      store.write({ provider: 'github', token: 'ghp_secret', login: null })
      store.close()
      const raw = new DatabaseSync(path)
      const row = raw.prepare('SELECT token_cipher FROM vcs_credential').get() as unknown as {
        token_cipher: string
      }
      raw.close()
      expect(row.token_cipher).not.toContain('ghp_secret')
      expect(row.token_cipher.startsWith('v1:')).toBe(true)
    })
  })

  it('reports no credential when the envelope cannot be opened (a rotated key)', () => {
    // One file, two keys: written sealed under KEY, read back by a store on OTHER_KEY. The
    // deployment must report NO usable credential — the state its sign-in screen already knows
    // how to fix — rather than a garbled token or a failed boot.
    withTempStore((path, store) => {
      store.write({ provider: 'github', token: 'ghp_secret', login: null })
      store.close()
      const rotated = createLocalVcsCredentialStore(path, OTHER_KEY)
      expect(rotated.read()).toBeNull()
      rotated.close()
    })
  })

  it('forgets the credential on clear', () => {
    const store = createLocalVcsCredentialStore(':memory:', KEY)
    store.write({ provider: 'github', token: 'ghp_x', login: null })
    store.clear()
    expect(store.read()).toBeNull()
  })
})
