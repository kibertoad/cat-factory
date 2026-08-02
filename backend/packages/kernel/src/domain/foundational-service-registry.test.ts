import { describe, expect, it } from 'vitest'
import { defaultFoundationalServiceRegistry } from './foundational-service-registry.js'

// The `builtin` tier's own unit: what a deployment registers in code, projected for the catalog
// merge (identity + manifests) and for the lazy contract read (the same manifests + bodies).

const OPENAPI = 'openapi: 3.0.3\npaths:\n  /files:\n    get: {}\n    post: {}\n'

const definition = {
  id: 'file-storage',
  name: 'File Storage',
  summary: 'Stores and serves user uploads.',
  description: 'Use for any binary blob.',
  capabilities: ['asset-storage'],
  contracts: [{ contractId: 'http', format: 'openapi' as const, title: 'HTTP API', body: OPENAPI }],
}

describe('FoundationalServiceRegistry', () => {
  it('projects a registered service with its operation index and no document body', () => {
    const registry = defaultFoundationalServiceRegistry()
    registry.register(definition)
    const [entry] = registry.entries()
    expect(entry).toMatchObject({ id: 'file-storage', capabilities: ['asset-storage'] })
    expect(entry?.contracts[0]).toMatchObject({
      operations: ['GET /files', 'POST /files'],
      size: OPENAPI.length,
      // A code-registered definition has no repo provenance; naming one would be a fiction.
      path: null,
    })
    expect(JSON.stringify(entry)).not.toContain('openapi: 3.0.3')
  })

  it('serves the SAME operation index with the document as the catalog showed', () => {
    // A consumer must never read a document whose operation list disagrees with the one the
    // design was chosen from, which is why both projections are built from one summary.
    const registry = defaultFoundationalServiceRegistry()
    registry.register(definition)
    const [document] = registry.documentsFor('file-storage')
    expect(document?.body).toBe(OPENAPI)
    expect(document?.operations).toEqual(registry.entries()[0]?.contracts[0]?.operations)
  })

  it('re-registering an id REPLACES it, and the projection follows', () => {
    const registry = defaultFoundationalServiceRegistry()
    registry.register(definition)
    expect(registry.entries()[0]?.name).toBe('File Storage')
    registry.register({ ...definition, name: 'Blob Store', contracts: [] })
    expect(registry.entries()).toHaveLength(1)
    expect(registry.entries()[0]?.name).toBe('Blob Store')
    // The memoised projection has to be dropped on a write, or the second registration is
    // invisible to every workspace that already resolved a catalog in this process.
    expect(registry.documentsFor('file-storage')).toEqual([])
  })

  it('answers an unregistered id with no documents rather than throwing', () => {
    expect(defaultFoundationalServiceRegistry().documentsFor('nope')).toEqual([])
  })
})
