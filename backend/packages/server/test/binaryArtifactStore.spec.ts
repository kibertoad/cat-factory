import type {
  BinaryArtifactMetadataStore,
  BinaryArtifactRecord,
  BinaryBlobBackend,
  Clock,
  IdGenerator,
} from '@cat-factory/kernel'
import { describe, expect, it, vi } from 'vitest'
import {
  type BuildBlobBackend,
  makeResolveBinaryArtifactStore,
} from '../src/persistence/binaryArtifactStore.js'

// A metadata store stub — the resolver only composes it into the store; these tests assert
// backend SELECTION + caching, so the metadata store is never actually read/written.
const metadata = {} as BinaryArtifactMetadataStore
const idGenerator: IdGenerator = { next: (p) => `${p}-1` }
const clock: Clock = { now: () => 1 }

/** A blob backend whose kind echoes what the factory was asked to build, for assertions. */
function fakeBackend(kind: BinaryArtifactRecord['storage']): BinaryBlobBackend {
  return {
    kind,
    put: () => Promise.resolve(),
    get: () => Promise.resolve(null),
    delete: () => Promise.resolve(),
  }
}

describe('makeResolveBinaryArtifactStore', () => {
  const buildBlobBackend: BuildBlobBackend = (kind) =>
    kind === 'fs' || kind === 's3' || kind === 'r2' || kind === 'db' ? fakeBackend(kind) : null

  it('uses the runtime default when the account has no content-storage config', async () => {
    const accountSettings = { resolve: vi.fn().mockResolvedValue({ config: {} }) }
    const resolve = makeResolveBinaryArtifactStore({
      accountSettings,
      accountOf: () => Promise.resolve('acc-1'),
      metadata,
      idGenerator,
      clock,
      buildBlobBackend,
      defaultBackend: 'fs',
    })
    const store = await resolve('ws-1')
    expect(store).not.toBeNull()
    expect(accountSettings.resolve).toHaveBeenCalledWith('acc-1')
  })

  it('uses the account-configured backend over the default', async () => {
    const built: string[] = []
    const resolve = makeResolveBinaryArtifactStore({
      accountSettings: {
        resolve: () =>
          Promise.resolve({
            config: { contentStorage: { backend: 's3', s3: { region: 'r', bucket: 'b' } } },
            s3Credentials: { accessKeyId: 'a', secretAccessKey: 's' },
          }),
      },
      accountOf: () => Promise.resolve('acc-1'),
      metadata,
      idGenerator,
      clock,
      buildBlobBackend: (kind, opts) => {
        built.push(kind)
        expect(opts.s3).toEqual({ region: 'r', bucket: 'b' })
        expect(opts.s3Credentials).toEqual({ accessKeyId: 'a', secretAccessKey: 's' })
        return fakeBackend(kind === 's3' ? 's3' : 'fs')
      },
      defaultBackend: 'fs',
    })
    await resolve('ws-1')
    expect(built).toEqual(['s3'])
  })

  it('returns null when the effective backend is off', async () => {
    const resolve = makeResolveBinaryArtifactStore({
      accountSettings: { resolve: () => Promise.resolve({ config: {} }) },
      accountOf: () => Promise.resolve('acc-1'),
      metadata,
      idGenerator,
      clock,
      buildBlobBackend,
      defaultBackend: 'off',
    })
    expect(await resolve('ws-1')).toBeNull()
  })

  it('returns null when the runtime cannot serve the configured backend', async () => {
    const resolve = makeResolveBinaryArtifactStore({
      accountSettings: {
        resolve: () => Promise.resolve({ config: { contentStorage: { backend: 'fs' } } }),
      },
      accountOf: () => Promise.resolve('acc-1'),
      metadata,
      idGenerator,
      clock,
      // This runtime only serves r2/s3 (Cloudflare-like): fs ⇒ unsupported.
      buildBlobBackend: (kind) => (kind === 'r2' || kind === 's3' ? fakeBackend(kind) : null),
      defaultBackend: 'r2',
    })
    expect(await resolve('ws-1')).toBeNull()
  })

  it('works without account settings (no per-account override), using the default', async () => {
    let calls = 0
    const resolve = makeResolveBinaryArtifactStore({
      accountOf: () => Promise.resolve('acc-1'),
      metadata,
      idGenerator,
      clock,
      buildBlobBackend: (kind) => {
        calls += 1
        return fakeBackend(kind === 'r2' ? 'r2' : 'fs')
      },
      defaultBackend: 'r2',
    })
    expect(await resolve('ws-1')).not.toBeNull()
    expect(calls).toBe(1)
  })

  it('caches the composed store per account until the config signature changes', async () => {
    let backend: 'fs' | 's3' = 'fs'
    let builds = 0
    const resolve = makeResolveBinaryArtifactStore({
      accountSettings: {
        resolve: () => Promise.resolve({ config: { contentStorage: { backend } } }),
      },
      accountOf: () => Promise.resolve('acc-1'),
      metadata,
      idGenerator,
      clock,
      buildBlobBackend: (kind) => {
        builds += 1
        return fakeBackend(kind === 's3' ? 's3' : 'fs')
      },
      defaultBackend: 'off',
    })
    const first = await resolve('ws-1')
    const second = await resolve('ws-1')
    expect(second).toBe(first) // same instance, no rebuild
    expect(builds).toBe(1)
    // Switch the account's backend → the signature changes → rebuild.
    backend = 's3'
    const third = await resolve('ws-1')
    expect(third).not.toBe(first)
    expect(builds).toBe(2)
  })

  it('uses the default when a workspace has no account (legacy null)', async () => {
    const accountSettings = { resolve: vi.fn() }
    const resolve = makeResolveBinaryArtifactStore({
      accountSettings,
      accountOf: () => Promise.resolve(null),
      metadata,
      idGenerator,
      clock,
      buildBlobBackend,
      defaultBackend: 'fs',
    })
    expect(await resolve('ws-1')).not.toBeNull()
    expect(accountSettings.resolve).not.toHaveBeenCalled()
  })
})
