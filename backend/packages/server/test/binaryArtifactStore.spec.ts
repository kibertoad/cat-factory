import type {
  BinaryArtifactMetadataStore,
  BinaryArtifactRecord,
  BinaryBlobBackend,
  Clock,
  IdGenerator,
} from '@cat-factory/kernel'
import { BinaryStoreRegistry, createRecordingLogger } from '@cat-factory/kernel'
import type { ContentStorageCapability } from '@cat-factory/contracts'
import { describe, expect, it, vi } from 'vitest'
import {
  type BuildBlobBackend,
  makeResolveBinaryArtifactStore,
  withRegisteredBinaryStores,
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

/** A Node-like runtime: it serves the platform's own backends and nothing else. */
const buildBlobBackend: BuildBlobBackend = (kind) =>
  kind === 'fs' || kind === 's3' || kind === 'r2' || kind === 'db' ? fakeBackend(kind) : null

describe('makeResolveBinaryArtifactStore', () => {
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

  it('rebuilds the store when the S3 credentials are rotated (same presence, new values)', async () => {
    let creds = { accessKeyId: 'old', secretAccessKey: 'old-secret' }
    let builds = 0
    const resolve = makeResolveBinaryArtifactStore({
      accountSettings: {
        resolve: () =>
          Promise.resolve({
            config: { contentStorage: { backend: 's3', s3: { region: 'r', bucket: 'b' } } },
            s3Credentials: creds,
          }),
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
    expect(await resolve('ws-1')).toBe(first) // unchanged creds → cached
    expect(builds).toBe(1)
    // Rotate the keys (presence still configured, but the values differ) → rebuild.
    creds = { accessKeyId: 'new', secretAccessKey: 'new-secret' }
    const rotated = await resolve('ws-1')
    expect(rotated).not.toBe(first)
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

// Split from the block above rather than nested in it: the two ask different questions (which
// backend a config selects, versus how a DEPLOYMENT-REGISTERED one is built and remembered), and
// one `describe` covering both had grown past the max-lines-per-function ceiling.
describe('makeResolveBinaryArtifactStore with deployment-registered stores', () => {
  /** A metadata store that records what the composed store inserts (the `storage` tag matters). */
  function recordingMetadata(): {
    store: BinaryArtifactMetadataStore
    inserted: BinaryArtifactRecord[]
  } {
    const inserted: BinaryArtifactRecord[] = []
    return {
      inserted,
      store: {
        insert: (record: BinaryArtifactRecord) => {
          inserted.push(record)
          return Promise.resolve()
        },
      } as unknown as BinaryArtifactMetadataStore,
    }
  }

  const customConfig = (storeId: string) => ({
    config: { contentStorage: { backend: 'custom' as const, custom: { storeId } } },
  })

  it('builds a deployment-registered store and stamps ITS id onto the artifact', async () => {
    const registry = new BinaryStoreRegistry()
    const seenAccounts: (string | null)[] = []
    registry.register({
      id: 'gcs',
      name: 'Cloud Storage',
      create: (context) => {
        seenAccounts.push(context.accountId)
        // Declares a DIFFERENT kind on purpose: the row must name the registration, not this.
        return fakeBackend('blob')
      },
    })
    const metadataStore = recordingMetadata()
    const resolve = makeResolveBinaryArtifactStore({
      accountSettings: { resolve: () => Promise.resolve(customConfig('gcs')) },
      accountOf: () => Promise.resolve('acc-1'),
      metadata: metadataStore.store,
      idGenerator,
      clock,
      buildBlobBackend: () => {
        throw new Error('a custom store must not reach the runtime backend factory')
      },
      defaultBackend: 'off',
      binaryStoreRegistry: registry,
    })
    const store = await resolve('ws-1')
    if (!store) throw new Error('expected the registered store to resolve')
    await store.store({
      meta: {
        workspaceId: 'ws-1',
        executionId: null,
        blockId: null,
        kind: 'screenshot',
        view: null,
        contentType: 'image/png',
      },
      blob: new Uint8Array([1, 2, 3]),
    })
    expect(seenAccounts).toEqual(['acc-1'])
    expect(metadataStore.inserted.map((r) => r.storage)).toEqual(['gcs'])
  })

  it('rebuilds when the account switches between two registered stores', async () => {
    const registry = new BinaryStoreRegistry()
    let builds = 0
    for (const id of ['gcs', 'azure-blob']) {
      registry.register({
        id,
        name: id,
        create: () => {
          builds += 1
          return fakeBackend(id)
        },
      })
    }
    let selected = 'gcs'
    const resolve = makeResolveBinaryArtifactStore({
      accountSettings: { resolve: () => Promise.resolve(customConfig(selected)) },
      accountOf: () => Promise.resolve('acc-1'),
      metadata,
      idGenerator,
      clock,
      buildBlobBackend,
      defaultBackend: 'off',
      binaryStoreRegistry: registry,
    })
    const first = await resolve('ws-1')
    expect(await resolve('ws-1')).toBe(first)
    expect(builds).toBe(1)
    // Only the store id differs, so a signature that ignored it would keep writing to `gcs`.
    selected = 'azure-blob'
    expect(await resolve('ws-1')).not.toBe(first)
    expect(builds).toBe(2)
  })

  it('resolves to null and NAMES the id when this build registers no such store', async () => {
    const logger = createRecordingLogger()
    const resolve = makeResolveBinaryArtifactStore({
      accountSettings: { resolve: () => Promise.resolve(customConfig('gcs')) },
      accountOf: () => Promise.resolve('acc-1'),
      metadata,
      idGenerator,
      clock,
      buildBlobBackend,
      defaultBackend: 'off',
      binaryStoreRegistry: new BinaryStoreRegistry(),
      logger,
    })
    expect(await resolve('ws-1')).toBeNull()
    // The account looks configured and retains nothing, so the log line is the only thing that
    // can say why: it has to carry the id nobody registered.
    const warning = logger.lines.find((line) => line.level === 'warn')
    expect(warning?.fields).toMatchObject({ accountId: 'acc-1', storeId: 'gcs' })
  })

  it('resolves to null when a registered store declines to build', async () => {
    const registry = new BinaryStoreRegistry()
    registry.register({ id: 'gcs', name: 'Cloud Storage', create: () => null })
    const resolve = makeResolveBinaryArtifactStore({
      accountSettings: { resolve: () => Promise.resolve(customConfig('gcs')) },
      accountOf: () => Promise.resolve('acc-1'),
      metadata,
      idGenerator,
      clock,
      buildBlobBackend,
      defaultBackend: 'off',
      binaryStoreRegistry: registry,
    })
    expect(await resolve('ws-1')).toBeNull()
  })

  // ---- Remembering a refusal ----------------------------------------------
  //
  // A refusal is resolved on the same paths a success is: every artifact request, every infra
  // check, every engine advance, and once an hour per workspace from the retention sweep. Left
  // un-remembered, one misconfigured account re-derives it (and re-logs it) forever, which is how
  // the one line naming the unregistered id becomes the line an operator filters out.

  it('says an unregistered store id ONCE per account, not once per resolve', async () => {
    const logger = createRecordingLogger()
    const resolve = makeResolveBinaryArtifactStore({
      accountSettings: { resolve: () => Promise.resolve(customConfig('gcs')) },
      accountOf: () => Promise.resolve('acc-1'),
      metadata,
      idGenerator,
      clock,
      buildBlobBackend,
      defaultBackend: 'off',
      binaryStoreRegistry: new BinaryStoreRegistry(),
      logger,
    })
    for (let i = 0; i < 5; i++) expect(await resolve('ws-1')).toBeNull()

    expect(logger.lines.filter((line) => line.level === 'warn')).toHaveLength(1)
  })

  it('re-derives a refusal once the account edits the config that caused it', async () => {
    const registry = new BinaryStoreRegistry()
    registry.register({ id: 'azure-blob', name: 'Azure Blob', create: () => fakeBackend('azure') })
    const logger = createRecordingLogger()
    let selected = 'gcs'
    const resolve = makeResolveBinaryArtifactStore({
      accountSettings: { resolve: () => Promise.resolve(customConfig(selected)) },
      accountOf: () => Promise.resolve('acc-1'),
      metadata,
      idGenerator,
      clock,
      buildBlobBackend,
      defaultBackend: 'off',
      binaryStoreRegistry: registry,
      logger,
    })
    expect(await resolve('ws-1')).toBeNull()
    // The remembered refusal is keyed by the SAME signature a success is, so repointing the
    // account at a store this build does have must not keep serving the cached null.
    selected = 'azure-blob'
    expect(await resolve('ws-1')).not.toBeNull()
  })

  it('keeps asking a store that DECLINED, so an unset credential recovers without a restart', async () => {
    const registry = new BinaryStoreRegistry()
    let ready = false
    let creates = 0
    registry.register({
      id: 'gcs',
      name: 'Cloud Storage',
      create: () => {
        creates += 1
        return ready ? fakeBackend('gcs') : null
      },
    })
    const logger = createRecordingLogger()
    const resolve = makeResolveBinaryArtifactStore({
      accountSettings: { resolve: () => Promise.resolve(customConfig('gcs')) },
      accountOf: () => Promise.resolve('acc-1'),
      metadata,
      idGenerator,
      clock,
      buildBlobBackend,
      defaultBackend: 'off',
      binaryStoreRegistry: registry,
      logger,
    })
    expect(await resolve('ws-1')).toBeNull()
    expect(await resolve('ws-1')).toBeNull()
    // Asked again each time (the store's "not right now" is its own to revise), but reported once.
    expect(creates).toBe(2)
    expect(logger.lines.filter((line) => line.level === 'info')).toHaveLength(1)

    ready = true
    expect(await resolve('ws-1')).not.toBeNull()
  })

  it('stops re-running a runtime backend factory that cannot serve the account’s choice', async () => {
    let calls = 0
    const resolve = makeResolveBinaryArtifactStore({
      accountSettings: {
        resolve: () => Promise.resolve({ config: { contentStorage: { backend: 'fs' } } }),
      },
      accountOf: () => Promise.resolve('acc-1'),
      metadata,
      idGenerator,
      clock,
      // Cloudflare-like: `fs` is not servable here, and no amount of asking changes that.
      buildBlobBackend: (kind) => {
        calls += 1
        return kind === 'r2' ? fakeBackend('r2') : null
      },
      defaultBackend: 'r2',
    })
    expect(await resolve('ws-1')).toBeNull()
    expect(await resolve('ws-1')).toBeNull()
    expect(calls).toBe(1)
  })
})

describe('withRegisteredBinaryStores', () => {
  const runtime = (): ContentStorageCapability => ({
    supportedBackends: ['off', 'fs'],
    defaultBackend: 'fs',
    customStores: [],
  })

  it('offers `custom` only when the deployment registered something to select', () => {
    const bare = withRegisteredBinaryStores(runtime())
    expect(bare.supportedBackends).toEqual(['off', 'fs'])
    expect(bare.customStores).toEqual([])

    const registry = new BinaryStoreRegistry()
    registry.register({
      id: 'gcs',
      name: 'Cloud Storage',
      summary: 'The org bucket.',
      create: () => fakeBackend('gcs'),
    })
    const extended = withRegisteredBinaryStores(runtime(), registry)
    expect(extended.supportedBackends).toEqual(['off', 'fs', 'custom'])
    expect(extended.customStores).toEqual([
      { id: 'gcs', name: 'Cloud Storage', summary: 'The org bucket.' },
    ])
  })
})
