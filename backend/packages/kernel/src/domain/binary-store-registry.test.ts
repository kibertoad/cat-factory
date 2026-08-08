import { describe, expect, it } from 'vitest'
import { BUILTIN_BINARY_ARTIFACT_STORAGE_KINDS } from '../ports/binary-artifacts.js'
import type { BinaryBlobBackend } from '../ports/binary-artifacts.js'
import {
  BinaryStoreRegistrationError,
  BinaryStoreRegistry,
  defaultBinaryStoreRegistry,
} from './binary-store-registry.js'

const backend = (kind: string): BinaryBlobBackend => ({
  kind,
  put: () => Promise.resolve(),
  get: () => Promise.resolve(null),
  delete: () => Promise.resolve(),
})

describe('BinaryStoreRegistry', () => {
  it('starts empty, so a deployment that registers nothing offers nothing', () => {
    const registry = defaultBinaryStoreRegistry()
    expect(registry.size).toBe(0)
    expect(registry.ids()).toEqual([])
    expect(registry.views()).toEqual([])
  })

  it('builds a registered store per account', () => {
    const registry = new BinaryStoreRegistry()
    const seen: (string | null)[] = []
    registry.register({
      id: 'gcs',
      name: 'Cloud Storage',
      summary: 'The org bucket.',
      create: (context) => {
        seen.push(context.accountId)
        return backend('gcs')
      },
    })
    expect(registry.get('gcs')?.create({ accountId: 'acc-1' })?.kind).toBe('gcs')
    expect(registry.get('gcs')?.create({ accountId: null })?.kind).toBe('gcs')
    // The account reaches the factory, so a multi-tenant deployment can shard on it.
    expect(seen).toEqual(['acc-1', null])
    expect(registry.views()).toEqual([
      { id: 'gcs', name: 'Cloud Storage', summary: 'The org bucket.' },
    ])
  })

  it('lets a later registration replace an earlier one under the same id', () => {
    const registry = new BinaryStoreRegistry()
    registry.registerAll([
      { id: 'gcs', name: 'First', create: () => backend('gcs') },
      { id: 'gcs', name: 'Second', create: () => backend('gcs') },
    ])
    expect(registry.ids()).toEqual(['gcs'])
    expect(registry.get('gcs')?.name).toBe('Second')
  })

  it('refuses an id one of the platform’s own backends already answers to', () => {
    const registry = new BinaryStoreRegistry()
    // The load-bearing refusal: `s3`/`fs` are selected through their own account config, so a
    // store registered under one of those names would be offered in the picker and never built.
    for (const kind of BUILTIN_BINARY_ARTIFACT_STORAGE_KINDS) {
      expect(() =>
        registry.register({ id: kind, name: kind, create: () => backend(kind) }),
      ).toThrow(BinaryStoreRegistrationError)
    }
    expect(registry.size).toBe(0)
  })

  it('refuses an id the artifact row could not carry verbatim', () => {
    const registry = new BinaryStoreRegistry()
    for (const id of ['', 'Uppercase', 'has space', 'trailing/slash', '-leading', 'a'.repeat(64)]) {
      expect(() => registry.register({ id, name: id, create: () => backend(id) })).toThrow(
        BinaryStoreRegistrationError,
      )
    }
  })

  it('omits an absent summary rather than emitting an empty one', () => {
    const registry = new BinaryStoreRegistry()
    registry.register({ id: 'azure-blob', name: 'Azure Blob', create: () => backend('azure-blob') })
    expect(registry.views()).toEqual([{ id: 'azure-blob', name: 'Azure Blob' }])
  })
})
