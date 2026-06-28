import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FilesystemBinaryBlobBackend } from '../src/storage/FilesystemBinaryBlobBackend.js'

// Pure unit test (no Postgres): the filesystem blob backend reads/writes bytes under a base
// directory, the default content-storage backend in local mode.
describe('FilesystemBinaryBlobBackend', () => {
  let base: string
  let backend: FilesystemBinaryBlobBackend

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), 'cat-fs-blob-'))
    backend = new FilesystemBinaryBlobBackend({ basePath: base })
  })

  afterEach(async () => {
    await rm(base, { recursive: true, force: true })
  })

  it('reports its storage kind', () => {
    expect(backend.kind).toBe('fs')
  })

  it('creates the base directory eagerly', async () => {
    const nested = join(base, 'eager-create')
    new FilesystemBinaryBlobBackend({ basePath: nested })
    expect((await stat(nested)).isDirectory()).toBe(true)
  })

  it('round-trips bytes under a nested ws/id key (creating subdirs)', async () => {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])
    await backend.put('ws-1/art-1', bytes, 'image/png')
    // The bytes land in a per-workspace subdirectory.
    expect((await stat(join(base, 'ws-1'))).isDirectory()).toBe(true)
    const got = await backend.get('ws-1/art-1')
    expect(got).toEqual(bytes)
  })

  it('returns null for a missing key', async () => {
    expect(await backend.get('ws-1/missing')).toBeNull()
  })

  it('deletes a stored blob and is idempotent on a missing key', async () => {
    await backend.put('ws-1/art-1', new Uint8Array([1]), 'image/png')
    await backend.delete('ws-1/art-1')
    expect(await backend.get('ws-1/art-1')).toBeNull()
    // A second delete (now missing) is a no-op, not a throw.
    await expect(backend.delete('ws-1/art-1')).resolves.toBeUndefined()
  })

  it('rejects a key that escapes the storage root', async () => {
    await expect(backend.put('../escape', new Uint8Array([1]), 'image/png')).rejects.toThrow(
      /escapes the storage root/,
    )
    await expect(backend.get('../../etc/passwd')).rejects.toThrow(/escapes the storage root/)
  })
})
